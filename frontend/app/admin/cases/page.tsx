"use client";

// Admin case list (Story 5.3, FR-5.1/FR-7.1). Replaces Story 5.1's placeholder shell —
// the role-gate below (getUser() re-verification + signOut()-on-non-admin) is preserved
// UNCHANGED from that placeholder; only the final render is new. Fetches the district-
// scoped, filtered, sorted, paginated list from GET /api/v1/admin/cases via lib/adminCases.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
        isAdmin = !error && data.user?.user_metadata?.role === "admin";
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
    }),
    [searchParams],
  );
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
  }, [checked, filters.status, filters.from, filters.to, filters.type, filters.division, page, sortCol, sortDir, reloadNonce]);

  // Reset the Story 5.4 seam's selection whenever filters/sort/page change (code review
  // fix) -- otherwise a previously-selected case stays "selected" even after it's scrolled
  // out of the current filtered/paged result set.
  useEffect(() => {
    setSelectedOfflineId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.from, filters.to, filters.type, filters.division, page, sortCol, sortDir]);

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

  // Extracted (code review fix) so the desktop and mobile panes below can't drift out of
  // sync when Story 5.4 replaces one copy and forgets the other -- previously hand-
  // duplicated, byte-identical JSX.
  const selectedDetailContent = (
    <div className="rounded-md border border-border-default bg-surface-raised p-design-4 text-body text-ink-secondary">
      Case detail coming in Story 5.4 (selected: {selectedOfflineId}).
    </div>
  );

  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <div className="mx-auto max-w-6xl space-y-design-4">
        <h1 className="text-title text-ink-primary">Admin — Case List</h1>

        <AdminKpiCards kpis={data?.kpis ?? null} loading={state === "loading" && !data} />

        <FilterBar value={filters} onApply={handleApplyFilters} onClear={handleClearFilters} />

        {state === "loading" && !data && (
          <p className="text-body text-ink-secondary" role="status">
            Loading cases…
          </p>
        )}

        {state === "error" && (
          <div role="alert" className="space-y-design-2">
            <p className="text-body text-status-error">Couldn&apos;t load cases.</p>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
            >
              Retry
            </button>
          </div>
        )}

        {state === "ready" && data && data.items.length === 0 && (
          <p className="text-body text-ink-secondary">No cases match your current filters.</p>
        )}

        {data && data.items.length > 0 && (
          <div className="flex flex-col gap-design-4 lg:flex-row">
            <div className="overflow-x-auto lg:w-[40%]">
              <CaseListTable
                cases={data.items}
                onSort={handleSort}
                sortCol={sortCol}
                sortDir={sortDir}
                onSelect={setSelectedOfflineId}
                selectedOfflineId={selectedOfflineId}
              />

              {totalPages > 1 && (
                <nav
                  className="mt-design-3 flex items-center justify-between gap-design-2"
                  aria-label="Case list pagination"
                >
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => updateUrl({ page: page - 1 })}
                    className="min-h-touch-target rounded-md border border-border-default px-design-3 text-label disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-caption text-ink-secondary">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => updateUrl({ page: page + 1 })}
                    className="min-h-touch-target rounded-md border border-border-default px-design-3 text-label disabled:opacity-40"
                  >
                    Next
                  </button>
                </nav>
              )}
            </div>

            {/* Right pane is a layout seam for Story 5.4's case detail view — not built here. */}
            <div className="hidden lg:block lg:w-[60%]">
              {selectedOfflineId ? (
                selectedDetailContent
              ) : (
                <div className="rounded-md border border-dashed border-border-default p-design-4 text-body text-ink-disabled">
                  Select a case to view details.
                </div>
              )}
            </div>

            {selectedOfflineId && <div className="lg:hidden">{selectedDetailContent}</div>}
          </div>
        )}
      </div>
    </main>
  );
}
