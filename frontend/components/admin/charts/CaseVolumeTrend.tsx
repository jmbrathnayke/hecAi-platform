"use client";

// Case volume trend chart (Story 7.1, AC1). Fixed trailing-12-months line, independent of
// the page's date-range filter (the backend computes this window anchored to `to`, not the
// filter's `from` -- see admin.py's get_analytics comment). Single series -> a lone hue, no
// legend needed (dataviz skill: "none for one").
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsVolumePoint } from "@/lib/adminAnalytics";
import { AXIS_COLOR, GRID_COLOR, VOLUME_TREND_COLOR } from "./chartColors";

interface CaseVolumeTrendProps {
  data: AnalyticsVolumePoint[];
}

function monthLabel(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: "short", year: "2-digit" });
}

export function CaseVolumeTrend({ data }: CaseVolumeTrendProps) {
  const t = useTranslations("admin");
  const locale = useLocale();

  return (
    <section className="rounded-md border border-border-default bg-surface-raised p-design-4">
      <h2 className="text-headline text-ink-primary">{t("analytics.volumeTrend")}</h2>
      {data.length === 0 ? (
        <p className="mt-design-3 text-body text-ink-secondary">{t("analytics.noData")}</p>
      ) : (
        <div className="mt-design-3 h-64" role="img" aria-label={t("analytics.volumeTrend")}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(iso: string) => monthLabel(iso, locale)}
                stroke={AXIS_COLOR}
                fontSize={12}
                tickLine={false}
              />
              <YAxis allowDecimals={false} stroke={AXIS_COLOR} fontSize={12} tickLine={false} width={32} />
              <Tooltip
                formatter={(value: unknown) => [Number(value ?? 0), t("analytics.caseCount")]}
                labelFormatter={(iso: ReactNode) => monthLabel(String(iso), locale)}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke={VOLUME_TREND_COLOR}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
