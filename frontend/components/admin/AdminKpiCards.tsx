"use client";

// Admin dashboard KPI cards (Story 5.3 AC5, FR-7.1). District-wide, independent of the
// case list's own filters (a deliberate design choice — see admin.py's separate KPI
// queries, not the old stub's single combined query).
import { useTranslations } from "next-intl";
import type { AdminCaseKpis } from "@/lib/adminCases";
import { statusKey } from "@/lib/status";
import { STATUS_VALUES } from "@/components/admin/statusVocabulary";

interface AdminKpiCardsProps {
  kpis: AdminCaseKpis | null;
  loading: boolean;
}

// Currency stays "Rs." + en-LK grouping (Sri Lankan number format is locale-invariant across the
// UI languages here; Story 6.3 CRITICAL #7 keeps this untranslated).
function formatLkr(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

function KpiCard({
  label,
  value,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-md border border-border-default bg-surface-raised p-design-4 ${className}`}
    >
      <div className="text-label text-ink-secondary">{label}</div>
      <div className="mt-design-1 text-title text-ink-primary">{value}</div>
    </div>
  );
}

// The status breakdown is a MULTI-VALUE KPI, unlike the other three (a single number each).
// Rendering it as one joined "Submitted: 12, Under Review: 3, …" string in the 22px `text-title`
// slot blew the card's height out in the mobile 2-column grid (~160px of width for the whole
// sentence). Stacked label/count rows at `text-label` keep it readable at 360px and let the card
// span the full row on mobile (see col-span below).
function StatusBreakdownValue({ entries }: { entries: [string, number][] }) {
  if (entries.length === 0) return <span className="text-title text-ink-primary">—</span>;
  return (
    <dl className="flex flex-col gap-design-1">
      {entries.map(([label, count]) => (
        <div key={label} className="flex items-baseline justify-between gap-design-2">
          <dt className="text-label text-ink-secondary">{label}</dt>
          <dd className="text-label font-semibold tabular-nums text-ink-primary">{count}</dd>
        </div>
      ))}
    </dl>
  );
}

function KpiSkeleton() {
  return (
    <div className="rounded-md border border-border-default bg-surface-raised p-design-4">
      <div className="h-4 w-24 animate-pulse rounded bg-surface-tint" />
      <div className="mt-design-2 h-6 w-16 animate-pulse rounded bg-surface-tint" />
    </div>
  );
}

export function AdminKpiCards({ kpis, loading }: AdminKpiCardsProps) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");

  if (loading || !kpis) {
    return (
      <div className="grid grid-cols-2 gap-design-3 md:grid-cols-4" data-testid="kpi-skeleton">
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
      </div>
    );
  }

  // Falls back to the raw status string for any value outside the 5 canonical STATUS_VALUES
  // (the `status` column has no DB-level CHECK constraint) instead of rendering next-intl's
  // missing-message placeholder (Story 6.3 code review fix).
  const statusBreakdown: [string, number][] = Object.entries(kpis.by_status).map(
    ([status, count]) => {
      const label = (STATUS_VALUES as readonly string[]).includes(status)
        ? tStatus(`statusLabels.${statusKey(status)}`)
        : status;
      return [label, count];
    },
  );

  return (
    <div className="grid grid-cols-2 gap-design-3 md:grid-cols-4">
      <KpiCard label={t("kpi.thisMonth")} value={kpis.this_month} />
      {/* col-span-2 on mobile: this card holds up to 5 label/count rows, so it gets the full
          row width rather than half of a 360px screen. Back to a normal 1-of-4 cell at md. */}
      <KpiCard
        label={t("kpi.byStatus")}
        value={<StatusBreakdownValue entries={statusBreakdown} />}
        className="col-span-2 md:col-span-1"
      />
      <KpiCard label={t("kpi.totalApproved")} value={formatLkr(kpis.total_approved_lkr)} />
      <KpiCard
        label={t("kpi.avgProcessing")}
        value={kpis.avg_processing_days != null ? kpis.avg_processing_days : "—"}
      />
    </div>
  );
}
