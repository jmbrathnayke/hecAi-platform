// Admin compensation-caps settings data layer (Story 5.6, FR-4.4). Fetches/updates
// GET/PUT /api/v1/admin/settings/compensation-caps with the admin's Supabase JWT -- the
// backend validates district + amount and hardcodes damage_type to "property" (the only value
// the RF model ever reads, see backend/app/infrastructure/ml/compensation.py's
// _DAMAGE_TYPE_MAP) -- this module just shapes the request/response, no business logic here.
// Same UNAUTHORIZED-sentinel/null-on-failure contract as lib/adminCaseDetail.ts's functions.
import { UNAUTHORIZED } from "@/lib/adminCases";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface CompensationCap {
  district: string;
  damage_type: string;
  cap_amount_lkr: number;
  updated_by: string | null;
  updated_at: string | null;
}

export { UNAUTHORIZED };

export async function fetchCompensationCaps(
  token: string,
): Promise<CompensationCap[] | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/settings/compensation-caps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    const body = (await res.json()) as { caps: CompensationCap[] };
    return body.caps;
  } catch {
    return null;
  }
}

export async function updateCompensationCap(
  token: string,
  district: string,
  capAmountLkr: number,
): Promise<CompensationCap | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/settings/compensation-caps`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ district, cap_amount_lkr: capAmountLkr }),
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    return (await res.json()) as CompensationCap;
  } catch {
    return null;
  }
}
