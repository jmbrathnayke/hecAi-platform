"use client";

// AI performance metrics section (Story 7.1, AC2): confidence distribution histogram (10
// buckets), override-rate trend (this month vs last), avg AI processing time. Histogram is a
// single series -> lone hue, no legend. Bucket-range labels ("0–10%") are locale-invariant
// digits/symbols, not translated words -- same precedent as formatLkr's digit grouping.
import { useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsAiMetrics } from "@/lib/adminAnalytics";
import { AI_HISTOGRAM_COLOR, AXIS_COLOR, GRID_COLOR } from "./chartColors";

interface AIMetricsProps {
  data: AnalyticsAiMetrics;
}

function bucketLabel(i: number): string {
  return `${i * 10}–${i * 10 + 10}%`;
}

const TREND_ARROW: Record<AnalyticsAiMetrics["override_rate_trend"]["direction"], string> = {
  up: "↑",
  down: "↓",
  flat: "→",
  no_data: "",
};

export function AIMetrics({ data }: AIMetricsProps) {
  const t = useTranslations("admin");

  const histogramData = data.confidence_histogram.map((count, i) => ({
    bucket: bucketLabel(i),
    count,
  }));
  const { direction, this_month_pct, last_month_pct } = data.override_rate_trend;

  return (
    <section className="rounded-md border border-border-default bg-surface-raised p-design-4">
      <h2 className="text-headline text-ink-primary">{t("analytics.aiMetrics")}</h2>

      <div className="mt-design-3 grid grid-cols-1 gap-design-4 sm:grid-cols-2">
        <div>
          <h3 className="text-label text-ink-secondary">{t("analytics.confidenceHistogram")}</h3>
          {data.sample_count === 0 ? (
            <p className="mt-design-2 text-body text-ink-secondary">{t("analytics.noData")}</p>
          ) : (
            <div className="mt-design-2 h-48" role="img" aria-label={t("analytics.confidenceHistogram")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={histogramData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="bucket" stroke={AXIS_COLOR} fontSize={11} tickLine={false} interval={1} />
                  <YAxis allowDecimals={false} stroke={AXIS_COLOR} fontSize={12} tickLine={false} width={28} />
                  <Tooltip formatter={(value: unknown) => [Number(value ?? 0), t("analytics.caseCount")]} />
                  <Bar dataKey="count" fill={AI_HISTOGRAM_COLOR} radius={[4, 4, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-design-4">
          <div>
            <h3 className="text-label text-ink-secondary">{t("analytics.overrideRateTrend")}</h3>
            {direction === "no_data" ? (
              <p className="mt-design-1 text-body text-ink-secondary">{t("analytics.noData")}</p>
            ) : (
              <p className="mt-design-1 text-title text-ink-primary">
                <span aria-hidden="true">{TREND_ARROW[direction]}</span>{" "}
                {this_month_pct}%{" "}
                <span className="text-caption text-ink-secondary">
                  {t(`analytics.trend.${direction}`, { last: last_month_pct ?? 0 })}
                </span>
              </p>
            )}
          </div>

          <div>
            <h3 className="text-label text-ink-secondary">{t("analytics.avgProcessingTime")}</h3>
            <p className="mt-design-1 text-title text-ink-primary">
              {data.avg_processing_time_ms != null
                ? t("analytics.processingTimeValue", { ms: Math.round(data.avg_processing_time_ms) })
                : "—"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
