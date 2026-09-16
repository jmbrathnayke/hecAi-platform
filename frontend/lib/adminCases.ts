// Admin case-list data layer (Story 5.3, FR-5.1/FR-7.1). Fetches GET /api/v1/admin/cases
// with the admin's Supabase JWT; the backend does all district scoping, filtering, sorting,
// and pagination — this module just shapes the request/response, no business logic here.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface AdminCaseListItem {
  canonical_id: string | null;
  offline_id: string | null;
  damage_category: string | null;
  status: string;
  submitted_at: string | null;
  updated_at: string | null;
  ai_confidence: number | null;
  /**
   * Whether a DWC field officer was physically present to see the damage.
   *
   * True only on the officer-assisted path: an officer went to the site, photographed the damage
   * and reviewed the classification. False means the citizen submitted from their own device and
   * nobody has verified that the damage is real, recent, theirs, or elephant-caused.
   *
   * This is the only field that distinguishes the two — `submitted_via` is "app" for both.
   */
  submitted_by_officer: boolean;
}

export interface AdminCaseKpis {
  this_month: number;
  by_status: Record<string, number>;
  total_approved_lkr: number;
  avg_processing_days: number | null;
}

export interface AdminCaseListResponse {
  total: number;
  page: number;
  limit: number;
  items: AdminCaseListItem[];
  kpis: AdminCaseKpis;
}

export interface AdminCaseListParams {
  status?: string | null;
  from?: string | null;
  to?: string | null;
  type?: string | null;
  division?: string | null;
  page?: number;
  limit?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

// Distinguishes an expired/invalid session from a generic failure (code review fix) -- a
// 401/403 means Retry will just replay the same failing request forever; the caller should
// redirect to re-authenticate instead, the same "fail closed" pattern already used by this
// page's role gate.
export const UNAUTHORIZED = "unauthorized" as const;

export async function fetchAdminCases(
  token: string,
  params: AdminCaseListParams = {},
): Promise<AdminCaseListResponse | null | typeof UNAUTHORIZED> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") qs.set(key, String(value));
  }
  const query = qs.toString();

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/cases${query ? `?${query}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    return (await res.json()) as AdminCaseListResponse;
  } catch {
    return null;
  }
}
