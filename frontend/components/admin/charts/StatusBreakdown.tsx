"use client";

// Status distribution donut (Story 7.1, AC1). Categorical -- fixed hue per status (never
// cycled/reassigned by which statuses happen to be present), reusing status.statusLabels for
// display text and the shared statusVocabulary.ts status set (Story 6.3 pattern) rather than
// duplicating labels. The Approved color WARNs on contrast-vs-surface in the dataviz
// validator, so identity is never color-alone here: a text legend with every status's name +
// count is always rendered alongside the wedges (see chartColors.ts for the validation note).
import { useTranslations } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { statusKey } from "@/lib/status";
import { STATUS_VALUES } from "@/components/admin/statusVocabulary";
import { STATUS_CHART_COLORS, STATUS_CHART_FALLBACK_COLOR } from "./chartColors";

interface StatusBreakdownProps {
  data: Record<string, number>;
}

export function StatusBreakdown({ data }: StatusBreakdownProps) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");

  const entries = Object.entries(data).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  // Falls back to the raw status string for a value outside the 5 canonical STATUS_VALUES
  // (the `status` column has no DB CHECK constraint) -- same guard AdminKpiCards uses.
  const label = (status: string) =>
    (STATUS_VALUES as readonly string[]).includes(status)
      ? tStatus(`statusLabels.${statusKey(status)}`)
      : status;
  const color = (status: string) => STATUS_CHART_COLORS[status] ?? STATUS_CHART_FALLBACK_COLOR;

  return (
    <section className="rounded-md border border-border-default bg-surface-raised p-design-4">
      <h2 className="text-headline text-ink-primary">{t("analytics.statusDistribution")}</h2>
      {total === 0 ? (
        <p className="mt-design-3 text-body text-ink-secondary">{t("analytics.noData")}</p>
      ) : (
        <div className="mt-design-3 flex flex-col gap-design-3 sm:flex-row sm:items-center">
          <div className="h-48 w-full sm:w-1/2" role="img" aria-label={t("analytics.statusDistribution")}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={entries.map(([status, count]) => ({ status, count }))} dataKey="count" nameKey="status" innerRadius="55%" outerRadius="85%" stroke="#FFFFFF" strokeWidth={2}>
                  {entries.map(([status]) => (
                    <Cell key={status} fill={color(status)} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: unknown, _name, item) => {
                    const status = (item as { payload?: { status?: string } }).payload?.status ?? "";
                    return [Number(value ?? 0), label(status)];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Text legend (never color-alone) -- required relief for StatusBreakdown's
              contrast WARN, and satisfies "identity never color-alone" for >= 2 series. */}
          <ul className="flex flex-1 flex-col gap-design-1">
            {entries.map(([status, count]) => (
              <li key={status} className="flex items-center gap-design-2 text-body text-ink-primary">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: color(status) }}
                />
                <span className="flex-1">{label(status)}</span>
                <span className="text-ink-secondary">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
