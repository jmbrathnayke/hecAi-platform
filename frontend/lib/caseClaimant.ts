// Who submitted a case: the registered household behind it (backend app/api/v1/case_claimant.py).
//
// Read by the officer's case screen, the administrator's case file and the Divisional
// Secretariat's payment card, one case at a time. The server decides everything that matters:
// scope comes from the verified JWT, and the bank account's last four digits are returned to the
// DS officer only. No NIC exists to fetch — the platform stores only its digest.
//
// Failures are a discriminated union, same discipline as lib/casePhotos.ts.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface ClaimantMember {
  full_name: string | null;
  relationship: string | null;
  is_registrant: boolean;
}

export interface ClaimantHousehold {
  household_ref: string;
  district: string;
  ds_division: string;
  gn_division: string | null;
  status: string;
  registered_at: string | null;
  address: string | null;
  contact_email: string | null;
  contact_mobile: string | null;
  /** Present for the DS officer only. */
  bank_account_last4?: string | null;
  /** Migration 041: registered in the field by a DWC officer rather than by the family. */
  registered_by_officer?: boolean;
  /** When the Divisional Secretariat verified an officer-registered household; null until then. */
  verified_at?: string | null;
  /** Officer-registered and not yet verified: payment is held. */
  provisional?: boolean;
  members: ClaimantMember[];
}

export type ClaimantFailure =
  | { reason: "no-session" }
  | { reason: "signed-out" }
  | { reason: "not-found" }
  | { reason: "network" }
  | { reason: "server" };

export type ClaimantResult =
  | { ok: true; household: ClaimantHousehold | null }
  | { ok: false; failure: ClaimantFailure };

/** The household that filed `ref` (canonical or offline id); `household: null` when none is linked. */
export async function fetchCaseClaimant(ref: string): Promise<ClaimantResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/cases/${encodeURIComponent(ref)}/claimant`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (res.status === 401) return { ok: false, failure: { reason: "signed-out" } };
  if (res.status === 404) return { ok: false, failure: { reason: "not-found" } };
  if (!res.ok) return { ok: false, failure: { reason: "server" } };

  try {
    const body = (await res.json()) as { household?: ClaimantHousehold | null };
    return { ok: true, household: body.household ?? null };
  } catch {
    return { ok: false, failure: { reason: "server" } };
  }
}
