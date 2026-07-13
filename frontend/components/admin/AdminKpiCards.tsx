"use client";

// Admin dashboard KPI cards (Story 5.3 AC5, FR-7.1). District-wide, independent of the
// case list's own filters (a deliberate design choice — see admin.py's separate KPI
// queries, not the old stub's single combined query).
import type { AdminCaseKpis } from "@/lib/adminCases";

interface AdminKpiCardsProps {
  kpis: AdminCaseKpis | null;
  loading: boolean;
}

function formatLkr(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

function KpiCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-default bg-surface-raised p-design-4">
      <div className="text-label text-ink-secondary">{label}</div>
      <div className="mt-design-1 text-title text-ink-primary">{value}</div>
    </div>
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

  const statusBreakdown =
    Object.entries(kpis.by_status)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ") || "—";

  return (
    <div className="grid grid-cols-2 gap-design-3 md:grid-cols-4">
      <KpiCard label="Cases This Month" value={kpis.this_month} />
      <KpiCard label="By Status" value={statusBreakdown} />
      <KpiCard label="Total Approved (LKR)" value={formatLkr(kpis.total_approved_lkr)} />
      <KpiCard
        label="Avg Processing (Days)"
        value={kpis.avg_processing_days != null ? kpis.avg_processing_days : "—"}
      />
    </div>
  );
}
