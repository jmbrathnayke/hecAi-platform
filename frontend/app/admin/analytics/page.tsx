"use client";

// Admin analytics dashboard (Story 7.1, FR-7.1). Same role-gate pattern as
// app/admin/cases/page.tsx (Story 5.1, unchanged). No shared AdminLayout exists in this
// codebase (Story 6.1/6.3 precedent) -- this page is self-contained like cases/login.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/auth";
import { fetchAdminAnalytics, UNAUTHORIZED, type AdminAnalyticsResponse } from "@/lib/adminAnalytics";
import { CaseVolumeTrend } from "@/components/admin/charts/CaseVolumeTrend";
import { StatusBreakdown } from "@/components/admin/charts/StatusBreakdown";
import { CompensationTotal } from "@/components/admin/charts/CompensationTotal";
import { AIMetrics } from "@/components/admin/charts/AIMetrics";
import { LanguageSelectorCookie } from "@/components/LanguageSelectorCookie";

type LoadState = "loading" | "error" | "ready";

function isoDate(d: Date): string {
  // Code review fix: `d.toISOString().slice(0, 10)` converts to UTC before slicing. For this
  // app's Sri Lanka (UTC+5:30) admins, any local time before ~05:30 would resolve the
  // default "to" date to the PREVIOUS day. Build the date string from local components.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Mirrors the backend's own default (AC3): last 30 days, ending today. Computed client-side
// so the date inputs visibly reflect what's actually being queried, rather than sending no
// params and leaving the active range implicit.
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: isoDate(from), to: isoDate(to) };
}

export default function AdminAnalyticsPage() {
  const t = useTranslations("admin");
  const router = useRouter();

  // --- Role gate (Story 5.1, unchanged pattern) -----------------------------------------
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

  // --- Analytics data (Story 7.1) --------------------------------------------------------
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState<AdminAnalyticsResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [reloadNonce, setReloadNonce] = useState(0);

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
      const result = await fetchAdminAnalytics(token, { from: range.from, to: range.to });
      if (!active) return;
      if (result === UNAUTHORIZED) {
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
    // router omitted (code review precedent, app/admin/cases/page.tsx): router.replace is
    // used inside but is not a reactive dependency -- including it re-fires this effect on
    // every render once the mock (and, in principle, any router-instance change) produces a
    // new object reference each time, causing a duplicate-fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, range.from, range.to, reloadNonce]);

  if (!checked) return null;

  return (
    <main className="min-h-full bg-surface-base px-design-4 py-design-6">
      <div className="mx-auto max-w-6xl space-y-design-4">
        <header className="flex flex-wrap items-start justify-between gap-design-2">
          <div>
            <h1 className="text-title text-ink-primary">{t("analytics.title")}</h1>
            <Link href="/admin/cases" className="text-label text-civic underline">
              {t("analytics.backToCases")}
            </Link>
          </div>
          <div className="flex flex-col gap-design-1">
            <span className="text-caption text-ink-secondary">{t("languageLabel")}</span>
            <LanguageSelectorCookie />
          </div>
        </header>

        <form
          className="flex flex-wrap items-end gap-design-3"
          aria-label={t("analytics.filterAria")}
          onSubmit={(e) => e.preventDefault()}
        >
          <label className="flex flex-col gap-design-1 text-label text-ink-secondary">
            {t("analytics.from")}
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body"
            />
          </label>
          <label className="flex flex-col gap-design-1 text-label text-ink-secondary">
            {t("analytics.to")}
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body"
            />
          </label>
        </form>

        {state === "loading" && !data && (
          <p className="text-body text-ink-secondary" role="status">
            {t("analytics.loading")}
          </p>
        )}

        {state === "error" && (
          <div role="alert" className="space-y-design-2">
            <p className="text-body text-status-error">{t("analytics.loadError")}</p>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
            >
              {t("analytics.retry")}
            </button>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-design-4 lg:grid-cols-2">
            <CaseVolumeTrend data={data.volume_trend} />
            <StatusBreakdown data={data.status_distribution} />
            <CompensationTotal data={data.compensation_by_month} />
            <AIMetrics data={data.ai_metrics} />
          </div>
        )}
      </div>
    </main>
  );
}
