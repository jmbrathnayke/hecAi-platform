// Admin case-detail data layer (Story 5.4, FR-5.2). Fetches GET /api/v1/admin/cases/<id>
// and GET /api/v1/admin/audit/verify-chain with the admin's Supabase JWT; the backend does
// all district scoping and PII exclusion — this module just shapes the request/response, no
// business logic here. Mirrors lib/adminCases.ts's exact shape (Story 5.3), including the
// UNAUTHORIZED sentinel, which is imported (not redefined) so both modules agree on it.
import { UNAUTHORIZED } from "@/lib/adminCases";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface AdminCaseDetailCase {
  canonical_id: string | null;
  offline_id: string | null;
  damage_category: string | null;
  status: string;
  gps_lat: number | null;
  gps_lng: number | null;
  submitted_at: string | null;
  updated_at: string | null;
  submitted_via: string | null;
  submitter_identity_hash: string | null;
  approved_amount: number | null;
}

export interface AdminAiResult {
  model_type: string;
  model_version: string;
  prediction: string;
  confidence: number | null;
  was_overridden: boolean;
  override_reason: string | null;
  override_category: string | null;
  ai_severity: string | null;
  created_at: string | null;
}

export interface AdminCompensation {
  amount_lkr: number;
  raw_estimate_lkr: number;
  capped: boolean;
  feature_values: Record<string, unknown>;
  model_version: string;
  dataset_version: string | null;
  created_at: string | null;
}

export interface AdminAuditEntry {
  id: number;
  event: string;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  hash: string | null;
  prev_hash: string | null;
}

export interface AdminCaseDetailResponse {
  case: AdminCaseDetailCase;
  ai_result: AdminAiResult | null;
  compensation: AdminCompensation | null;
  audit_trail: AdminAuditEntry[];
}

export interface VerifyChainResult {
  valid: boolean;
  broken_id: number | null;
}

export { UNAUTHORIZED };

export async function fetchAdminCaseDetail(
  token: string,
  offlineId: string,
): Promise<AdminCaseDetailResponse | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/cases/${encodeURIComponent(offlineId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    return (await res.json()) as AdminCaseDetailResponse;
  } catch {
    return null;
  }
}

export async function verifyAuditChain(
  token: string,
): Promise<VerifyChainResult | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/audit/verify-chain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return UNAUTHORIZED;
    if (!res.ok) return null;
    return (await res.json()) as VerifyChainResult;
  } catch {
    return null;
  }
}
