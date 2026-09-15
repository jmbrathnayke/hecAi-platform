"use client";

// Total approved compensation by month (Story 7.1, AC1). Single series -> lone hue, no
// legend. Currency stays "Rs." + en-LK grouping (Story 6.3 CRITICAL #7 -- locale-invariant
// LKR formatting, matches AdminKpiCards' formatLkr).
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsCompensationPoint } from "@/lib/adminAnalytics";
import { AXIS_COLOR, COMPENSATION_COLOR, GRID_COLOR } from "./chartColors";

interface CompensationTotalProps {
  data: AnalyticsCompensationPoint[];
}

function monthLabel(iso: string, locale: string): string {
  // timeZone: "UTC" (code review fix): `iso` is a UTC-midnight date string from the backend;
  // without pinning the format to UTC, a viewer in a negative-UTC-offset timezone would see
  // the label shift back one calendar day/month.
  return new Date(iso).toLocaleDateString(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function formatLkr(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

export function CompensationTotal({ data }: CompensationTotalProps) {
  const t = useTranslations("admin");
  const locale = useLocale();

  // Code review fix: `.some((d) => d.total_lkr > 0)` treated "every month totals exactly
  // $0" as "no data" -- but a $0 approved amount is an explicitly valid, tested value
  // (backend test_action_approve_at_a_zero_rf_estimate_succeeds). Presence of any month
  // entry at all is what "no data" should mean here, not the values within them.
  const hasData = data.length > 0;

  return (
    <section className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4">
      <h2 className="text-headline text-ink-primary">{t("analytics.compensationTotal")}</h2>
      {!hasData ? (
        <p className="mt-design-3 text-body text-ink-secondary">{t("analytics.noData")}</p>
      ) : (
        <div className="mt-design-3 h-64" role="img" aria-label={t("analytics.compensationTotal")}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(iso: string) => monthLabel(iso, locale)}
                stroke={AXIS_COLOR}
                fontSize={12}
                tickLine={false}
              />
              <YAxis
                stroke={AXIS_COLOR}
                fontSize={12}
                tickLine={false}
                width={56}
                tickFormatter={(v: number) => v.toLocaleString("en-LK", { notation: "compact" })}
              />
              <Tooltip
                formatter={(value: unknown) => [
                  formatLkr(Number(value ?? 0)),
                  t("analytics.compensationTotal"),
                ]}
                labelFormatter={(iso: ReactNode) => monthLabel(String(iso), locale)}
              />
              <Bar dataKey="total_lkr" fill={COMPENSATION_COLOR} radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
