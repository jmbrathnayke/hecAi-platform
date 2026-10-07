"use client";

// Admin case list (Story 5.3, FR-5.1/FR-7.1). Replaces Story 5.1's placeholder shell —
// the role-gate below (getUser() re-verification + signOut()-on-non-admin) is preserved
// UNCHANGED from that placeholder; only the final render is new. Fetches the district-
// scoped, filtered, sorted, paginated list from GET /api/v1/admin/cases via lib/adminCases.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/auth";
import {
  fetchAdminCases,
  UNAUTHORIZED,
  type AdminCaseListResponse,
  type AdminCaseListParams,
} from "@/lib/adminCases";
import { CaseListTable, type SortColumn, type SortDirection } from "@/components/admin/CaseListTable";
import { FilterBar, type AdminCaseFilters } from "@/components/admin/FilterBar";
import { AdminKpiCards } from "@/components/admin/AdminKpiCards";
import { CaseDetailPanel } from "@/components/admin/CaseDetailPanel";
import { ExportButton } from "@/components/admin/ExportButton";
import { ArrowClockwise, CaretLeft, CaretRight, CursorClick, Tray } from "@phosphor-icons/react";
import { PageHeader, Skeleton, buttonStyles } from "@/components/admin/ui";

type LoadState = "loading" | "error" | "ready";
const PAGE_SIZE = 20;

// Mirrors backend/app/api/v1/admin.py's ALLOWED_SORT (code review fix) -- without this, a
// bookmarked/hand-edited ?sort=foo sets the UI's active-sort indicator to a non-existent
// column while the backend silently falls back to submitted_at server-side, a desync
// between what the UI shows and what's actually applied.
const ALLOWED_SORT = new Set<SortColumn>(["submitted_at", "canonical_id", "damage_category", "status"]);

// useSearchParams() requires a Suspense boundary (Next.js App Router) or the build fails
// with a static-bailout error — this page has no meaningful pre-search-params content to
// show while suspended (the role-gate itself needs searchParams-adjacent client state
// too), so the fallback is intentionally minimal.
export default function AdminCasesPage() {
  return (
    <Suspense fallback={null}>
      <AdminCasesPageContent />
    </Suspense>
  );
}

function AdminCasesPageContent() {
  const t = useTranslations("admin");
  const router = useRouter();
  const searchParams = useSearchParams();

  // --- Role gate (Story 5.1, unchanged) ------------------------------------------------
  const [checked, setChecked] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = createClient();

    (async () => {
      let isAdmin = false;
      try {
        const { data, error } = await supabase.auth.getUser();
        isAdmin = !error && data.user?.app_metadata?.role === "admin";
      } catch {
        isAdmin = false;
      }
      if (!mountedRef.current) return;

      if (!isAdmin) {
        try {
          await supabase.auth.signOut();
        } catch {
          // Even if sign-out fails, we still refuse entry below.
        }
        if (mountedRef.current) router.replace("/admin/login");
        return;
      }
      setChecked(true);
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [router]);

  // --- Case list (Story 5.3) -----------------------------------------------------------
  const filters: AdminCaseFilters = useMemo(
    () => ({
      status: searchParams.get("status") ?? "",
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      type: searchParams.get("type") ?? "",
      division: searchParams.get("division") ?? "",
      assessment: searchParams.get("assessment") ?? "",
      officer: searchParams.get("officer") ?? "",
    }),
    [searchParams],
  );
  // A staff notification opens /admin/cases?ref=HEC-…: the list narrows to that case and its
  // detail opens. Not part of the filter bar (it is a link target, not a working filter).
  const refParam = (searchParams.get("ref") ?? "").trim();
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  // Raw (undefaulted) sort param, kept alongside the resolved/whitelisted value below so
  // handleSort can distinguish "never explicitly touched" from "explicitly cycled back
  // here" (code review fix, AC3) -- resolving sortCol to "submitted_at" as a default made
  // the Submission Date column indistinguishable from having been explicitly clicked back
  // to its own default, so a fresh page load's first click on it was a no-op instead of
  // going ascending.
  const rawSort = searchParams.get("sort");
  const explicitSortCol: SortColumn | null =
    rawSort && ALLOWED_SORT.has(rawSort as SortColumn) ? (rawSort as SortColumn) : null;
  const sortCol: SortColumn = explicitSortCol ?? "submitted_at";
  const sortDir: SortDirection = searchParams.get("dir") === "asc" ? "asc" : "desc";

  const [data, setData] = useState<AdminCaseListResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [selectedOfflineId, setSelectedOfflineId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const updateUrl = useCallback(
    (next: Partial<AdminCaseFilters & { page: number; sort: SortColumn; dir: SortDirection }>) => {
      const qs = new URLSearchParams(searchParams.toString());
      const merged = { ...filters, page, sort: sortCol, dir: sortDir, ...next };
      // sort/dir are only omittable as a pair when they JOINTLY equal the true default
      // (code review fix) -- omitting `sort=submitted_at` unconditionally regardless of
      // `dir` meant an explicit ascending sort on the default column (sort=submitted_at,
      // dir=asc) lost its `sort` param on the next URL update, leaving only `dir=asc` in
      // the URL, which the reader would then misinterpret as descending-on-default.
      const sortIsDefault = merged.sort === "submitted_at" && merged.dir === "desc";
      const isDefault = (key: string, value: unknown) =>
        value === "" ||
        value == null ||
        (key === "page" && value === 1) ||
        (key === "sort" && sortIsDefault) ||
        (key === "dir" && sortIsDefault);
      for (const [key, value] of Object.entries(merged)) {
        if (isDefault(key, value)) {
          qs.delete(key);
        } else {
          qs.set(key, String(value));
        }
      }
      const query = qs.toString();
      router.push(query ? `/admin/cases?${query}` : "/admin/cases");
    },
    [filters, page, sortCol, sortDir, router, searchParams],
  );

  useEffect(() => {
    if (!checked) return;
    let active = true;
    (async () => {
      setState("loading");
      const token = await getAccessToken();
      if (!token) {
        if (active) setState("error");
        return;
      }
      const params: AdminCaseListParams = {
        status: filters.status || null,
        from: filters.from || null,
        to: filters.to || null,
        type: filters.type || null,
        division: filters.division || null,
        assessment: filters.assessment || null,
        officer: filters.officer || null,
        ref: refParam || null,
        page,
        limit: PAGE_SIZE,
        sort: sortCol,
        dir: sortDir,
      };
      const result = await fetchAdminCases(token, params);
      if (!active) return;
      if (result === UNAUTHORIZED) {
        // Session actually expired -- Retry would just replay the same failing request
        // forever, so redirect to re-authenticate instead (code review fix).
        router.replace("/admin/login");
        return;
      }
      if (!result) {
        setState("error");
        return;
      }
      setData(result);
      setState("ready");
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, filters.status, filters.from, filters.to, filters.type, filters.division, filters.assessment, filters.officer, refParam, page, sortCol, sortDir, reloadNonce]);

  // Reset the Story 5.4 seam's selection whenever filters/sort/page change (code review
  // fix) -- otherwise a previously-selected case stays "selected" even after it's scrolled
  // out of the current filtered/paged result set.
  useEffect(() => {
    setSelectedOfflineId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.from, filters.to, filters.type, filters.division, filters.assessment, filters.officer, refParam, page, sortCol, sortDir]);

  // Open the case a notification pointed at, once the narrowed list has loaded.
  useEffect(() => {
    if (!refParam || !data) return;
    const match = data.items.find((c) => (c.canonical_id ?? "").toUpperCase() === refParam.toUpperCase());
    if (match?.offline_id) setSelectedOfflineId(match.offline_id);
  }, [refParam, data]);

  function handleSort(col: SortColumn) {
    if (explicitSortCol !== col) {
      updateUrl({ sort: col, dir: "asc", page: 1 });
    } else if (sortDir === "asc") {
      updateUrl({ sort: col, dir: "desc", page: 1 });
    } else {
      // Third click on the same column resets to default (AC3).
      updateUrl({ sort: "submitted_at", dir: "desc", page: 1 });
    }
  }

  function handleApplyFilters(next: AdminCaseFilters) {
    updateUrl({ ...next, page: 1 });
  }

  function handleClearFilters() {
    router.push("/admin/cases");
  }

  if (!checked) return null;

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // Story 5.4 code review fix: a single mount point, not two. selectedDetailContent used to
  // be inserted at two separate JSX positions (a desktop `hidden lg:block` wrapper + a second
  // `lg:hidden` wrapper) -- safe when this seam held static placeholder text (Story 5.3), but
  // CSS `display:none` doesn't stop a component from mounting, and React doesn't dedupe by
  // JSX object identity across tree positions. Once this seam held a real, side-effecting
  // CaseDetailPanel, that pattern silently mounted TWO independent instances per case
  // selection -- doubling every fetch and every admin_viewed_case_detail audit-log write.
  // Rendered once here; the empty-state placeholder stays `hidden lg:block`-only so mobile
  // still shows nothing when no case is selected (unchanged from before).
  const selectedDetailContent = selectedOfflineId ? (
    <CaseDetailPanel offlineId={selectedOfflineId} />
  ) : (
    <div className="hidden flex-col items-center justify-center gap-design-2 rounded-md border border-dashed border-border-subtle px-design-5 py-design-8 text-center 2xl:flex">
      <CursorClick aria-hidden="true" size={28} className="text-ink-disabled" />
      <p className="max-w-[28ch] text-label text-ink-secondary">{t("cases.selectPrompt")}</p>
    </div>
  );

  const waiting = data?.kpis?.by_status?.Submitted ?? null;

  return (
    <main className="min-h-full bg-surface-base px-design-4 py-design-5 sm:px-design-5 lg:py-design-6">
      {/* Redesign (2026-10-07). The language switch and this device's notification switch moved
          into the top bar, so the page opens on the cases: header, district figures, filters,
          then the list beside the case it is showing. */}
      <div className="mx-auto max-w-[1440px] space-y-design-5">
        <PageHeader
          title={t("cases.title")}
          subtitle={waiting != null ? t("cases.subtitle", { count: waiting }) : undefined}
          actions={
            // Story 7.2: exports the CURRENT filter selection in full — `filters` only, never
            // page/sort/dir. Disabled while loading or when the filters match nothing.
            <ExportButton
              filters={filters}
              count={data?.total ?? 0}
              disabled={state === "loading" || !data || data.total === 0}
            />
          }
        />

        <AdminKpiCards kpis={data?.kpis ?? null} loading={state === "loading" && !data} />

        <FilterBar value={filters} onApply={handleApplyFilters} onClear={handleClearFilters} />

        {state === "loading" && !data && (
          <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-card">
            <p className="border-b border-border-subtle px-design-4 py-design-3 text-caption text-ink-secondary" role="status">
              {t("cases.loading")}
            </p>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-design-4 border-b border-border-subtle px-design-4 py-design-3 last:border-b-0">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="hidden h-4 w-12 sm:block" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
            ))}
          </div>
        )}

        {state === "error" && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-design-3 rounded-md border border-status-error/30 bg-status-error-pale px-design-4 py-design-3"
          >
            <p className="text-label text-status-error">{t("cases.loadError")}</p>
            <button type="button" onClick={() => setReloadNonce((n) => n + 1)} className={buttonStyles.secondary}>
              <ArrowClockwise aria-hidden="true" size={16} />
              {t("cases.retry")}
            </button>
          </div>
        )}

        {state === "ready" && data && data.items.length === 0 && (
          <div className="flex flex-col items-center gap-design-3 rounded-md border border-border-subtle bg-surface-raised px-design-5 py-design-8 text-center shadow-card">
            <span className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-tint text-forest">
              <Tray aria-hidden="true" size={24} />
            </span>
            <p className="text-body text-ink-primary">{t("cases.empty")}</p>
            <button type="button" onClick={handleClearFilters} className={buttonStyles.secondary}>
              {t("filter.clear")}
            </button>
          </div>
        )}

        {/* The list takes the remaining width and the case being read is a rail beside it that
            stays in view while the list scrolls. Below lg they stack, list first. */}
        {data && data.items.length > 0 && (
          <div className="flex flex-col gap-design-4 lg:flex-row lg:items-start">
            <div className="min-w-0 lg:flex-1">
              <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-card">
                <div className="flex items-center justify-between gap-design-3 border-b border-border-subtle px-design-4 py-design-3">
                  <h2 className="text-label font-semibold text-ink-primary">
                    {t("cases.resultCount", { count: data.total })}
                  </h2>
                </div>
                {/* The horizontal scroll happens INSIDE the surface, so the scrollbar belongs to
                    the list rather than to the page column. */}
                <div className="overflow-x-auto">
                  <CaseListTable
                    cases={data.items}
                    onSort={handleSort}
                    sortCol={sortCol}
                    sortDir={sortDir}
                    onSelect={setSelectedOfflineId}
                    selectedOfflineId={selectedOfflineId}
                    condensed={!!selectedOfflineId}
                  />
                </div>

                {totalPages > 1 && (
                  <nav
                    className="flex items-center justify-between gap-design-2 border-t border-border-subtle px-design-4 py-design-3"
                    aria-label={t("cases.paginationAria")}
                  >
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => updateUrl({ page: page - 1 })}
                      className={buttonStyles.secondary}
                    >
                      <CaretLeft aria-hidden="true" size={14} />
                      {t("cases.previous")}
                    </button>
                    <span className="text-caption tabular-nums text-ink-secondary">
                      {t("cases.pageOf", { page, total: totalPages })}
                    </span>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => updateUrl({ page: page + 1 })}
                      className={buttonStyles.secondary}
                    >
                      {t("cases.next")}
                      <CaretRight aria-hidden="true" size={14} />
                    </button>
                  </nav>
                )}
              </div>
            </div>

            {/* Right pane: case detail (Story 5.4). Single mount point (code review fix). On a
                desk it is a sticky rail with its own scroll, so the case stays beside the row
                that opened it; on a phone it stacks below the list. */}
            {/* With nothing selected the rail only holds a hint, so below 2xl it gives its width
                back to the list instead of squeezing the table for an empty box. */}
            <div
              className={
                selectedOfflineId
                  ? "lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100dvh-5.5rem)] lg:w-[420px] lg:shrink-0 lg:overflow-y-auto lg:overscroll-contain xl:w-[460px] 2xl:w-[520px]"
                  : "hidden 2xl:block 2xl:w-[520px] 2xl:shrink-0"
              }
            >
              {selectedDetailContent}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
