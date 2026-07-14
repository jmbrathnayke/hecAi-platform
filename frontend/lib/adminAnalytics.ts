// Admin analytics data layer (Story 7.1, FR-7.1). Fetches GET /api/v1/admin/analytics with
// the admin's Supabase JWT; the backend does all district scoping and date-range filtering
// -- this module just shapes the request/response, no business logic here. Mirrors
// lib/adminCases.ts's fetch-wrapper pattern (typed params, UNAUTHORIZED sentinel).
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface AnalyticsVolumePoint {
  month: string; // ISO date, first of month
  count: number;
}

export interface AnalyticsCompensationPoint {
  month: string; // ISO date, first of month
  total_lkr: number;
}

export interface AnalyticsOverrideTrend {
  this_month_pct: number | null;
  last_month_pct: number | null;
  direction: "up" | "down" | "flat" | "no_data";
}

export interface AnalyticsAiMetrics {
  confidence_histogram: number[]; // 10 buckets, 10%-wide
  sample_count: number;
  override_rate_trend: AnalyticsOverrideTrend;
  avg_processing_time_ms: number | null;
}

export interface AdminAnalyticsResponse {
  range: { from: string; to: string };
  volume_trend: AnalyticsVolumePoint[];
  status_distribution: Record<string, number>;
  compensation_by_month: AnalyticsCompensationPoint[];
  ai_metrics: AnalyticsAiMetrics;
}

export interface AdminAnalyticsParams {
  from?: string | null;
  to?: string | null;
}

// Distinguishes an expired/invalid session from a generic failure (same rationale as
// adminCases.ts's UNAUTHORIZED) -- the caller should redirect to re-authenticate, not retry.
export const UNAUTHORIZED = "unauthorized" as const;

export async function fetchAdminAnalytics(
  token: string,
  params: AdminAnalyticsParams = {},
): Promise<AdminAnalyticsResponse | null | typeof UNAUTHORIZED> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") qs.set(key, String(value));
  }
  const query = qs.toString();

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/analytics${query ? `?${query}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    return (await res.json()) as AdminAnalyticsResponse;
  } catch {
    return null;
  }
}
