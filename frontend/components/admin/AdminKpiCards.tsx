"use client";

// Admin dashboard KPIs (Story 5.3 AC5, FR-7.1). District-wide, independent of the case list's own
// filters (a deliberate design choice — see admin.py's separate KPI queries, not the old stub's
// single combined query).
//
// REDESIGN (2026-10-07). Four identical bordered cards became one strip: three figures side by
// side and the status breakdown as a proportion bar with a counted legend, because a breakdown is
// a share of a whole and a bar shows that at a glance where five stacked rows did not. Each figure
// keeps its label BEFORE its value in the DOM (screen readers announce "this month, 5") and
// flex-col-reverse puts the number visually on top.
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Info } from "@phosphor-icons/react";
import type { AdminCaseKpis } from "@/lib/adminCases";
import { statusKey } from "@/lib/status";
import { STATUS_FILLS, STATUS_VALUES } from "@/components/admin/statusVocabulary";
import { Skeleton } from "@/components/admin/ui";

interface AdminKpiCardsProps {
  kpis: AdminCaseKpis | null;
  loading: boolean;
}

// Currency stays "Rs." + en-LK grouping (Sri Lankan number format is locale-invariant across the
// UI languages here; Story 6.3 CRITICAL #7 keeps this untranslated).
function formatLkr(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col-reverse justify-end gap-design-1 bg-surface-raised p-design-4 sm:p-design-5">
      <div className="text-label text-ink-secondary">{label}</div>
      <div className="text-display font-semibold tabular-nums tracking-tight text-ink-primary">{value}</div>
    </div>
  );
}

interface StatusEntry {
  status: string;
  label: string;
  count: number;
}

function StatusMix({ label, entries }: { label: string; entries: StatusEntry[] }) {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  return (
    <div className="flex h-full flex-col gap-design-3 bg-surface-raised p-design-4 sm:p-design-5">
      <div className="flex items-baseline justify-between gap-design-2">
        <span className="text-label text-ink-secondary">{label}</span>
        {total > 0 && <span className="text-label font-semibold tabular-nums text-ink-primary">{total}</span>}
      </div>
      {total === 0 ? (
        <span className="text-display font-semibold text-ink-primary">—</span>
      ) : (
        <>
          <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-pill" aria-hidden="true">
            {entries
              .filter((e) => e.count > 0)
              .map((e) => (
                <span
                  key={e.status}
                  className={`h-full first:rounded-l-pill last:rounded-r-pill ${STATUS_FILLS[e.status] ?? "bg-ink-disabled"}`}
                  style={{ width: `${(e.count / total) * 100}%` }}
                />
              ))}
          </div>
          <dl className="grid grid-cols-1 gap-x-design-4 gap-y-design-1 sm:grid-cols-2">
            {entries.map((e) => (
              <div key={e.status} className="flex items-baseline justify-between gap-design-2">
                <dt className="flex min-w-0 items-center gap-design-2 truncate text-caption text-ink-secondary">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-2 w-2 shrink-0 rounded-[2px] ${STATUS_FILLS[e.status] ?? "bg-ink-disabled"}`}
                  />
                  {e.label}
                </dt>
                <dd className="text-caption font-semibold tabular-nums text-ink-primary">{e.count}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

const STRIP =
  "grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border-subtle bg-border-subtle shadow-card sm:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_1.7fr]";

export function AdminKpiCards({ kpis, loading }: AdminKpiCardsProps) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");

  if (loading || !kpis) {
    return (
      <div className={STRIP} data-testid="kpi-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-surface-raised p-design-4 sm:p-design-5">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="mt-design-2 h-4 w-28" />
          </div>
        ))}
        <div className="bg-surface-raised p-design-4 sm:col-span-3 sm:p-design-5 xl:col-span-1">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-design-3 h-2 w-full" />
          <Skeleton className="mt-design-3 h-3 w-3/4" />
        </div>
      </div>
    );
  }

  // Falls back to the raw status string for any value outside the 5 canonical STATUS_VALUES
  // (the `status` column has no DB-level CHECK constraint) instead of rendering next-intl's
  // missing-message placeholder (Story 6.3 code review fix).
  const statusBreakdown: StatusEntry[] = Object.entries(kpis.by_status).map(([status, count]) => ({
    status,
    label: (STATUS_VALUES as readonly string[]).includes(status)
      ? tStatus(`statusLabels.${statusKey(status)}`)
      : status,
    count,
  }));

  return (
    <div className="space-y-design-2">
      <div className={STRIP}>
        <Metric label={t("kpi.thisMonth")} value={kpis.this_month} />
        <Metric label={t("kpi.totalApproved")} value={formatLkr(kpis.total_approved_lkr)} />
        <Metric
          label={t("kpi.avgProcessing")}
          value={kpis.avg_processing_days != null ? kpis.avg_processing_days : "—"}
        />
        <div className="sm:col-span-3 xl:col-span-1">
          <StatusMix label={t("kpi.byStatus")} entries={statusBreakdown} />
        </div>
      </div>
      {/* These figures are district-wide and deliberately ignore the case list's active filters
          (see admin.py's separate KPI queries). Without saying so the page reads as broken: an
          admin narrows the list, watches every KPI sit still, and concludes the dashboard is
          stale. One line of copy is cheaper than that misread. */}
      <p className="flex items-center gap-design-1 text-caption text-ink-secondary" data-testid="kpi-scope-note">
        <Info aria-hidden="true" size={14} />
        {t("kpi.scopeNote")}
      </p>
    </div>
  );
}
