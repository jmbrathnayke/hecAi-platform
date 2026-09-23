// Divisional Secretariat case list client (Story 8.5).
//
// The backend does ALL division scoping from the verified JWT claim — this module never sends a
// division, and a DS officer's division is not something the client is allowed to choose.
//
// Failures are a discriminated union, same discipline as lib/households.ts and the officer
// dashboard fix of 2026-08-21: "your account has no division assigned" and "the server is down"
// need different screens and different actions, and collapsing them loses the difference.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface DsCase {
  canonical_id: string;
  offline_id: string | null;
  status: string;
  damage_category: string;
  submitted_via: string;
  submitted_at: string | null;
  updated_at: string | null;
  /** The DWC administrator's approved amount: a RECOMMENDATION to the DS office, not the decision. */
  approved_amount: number | null;
  /** null for pre-Epic-8 and seeded cases, which have no household (migration 025). */
  household_ref: string | null;
  // --- final governance workflow (optional: an older backend omits them) ----------------------
  /** Decision support from the Random Forest estimator. Never the final amount. */
  ai_estimate?: { amount_lkr: number | null; model_version: string | null; is_final_decision: false };
  district?: string | null;
  officer_assessed?: boolean;
  /** The Divisional Secretariat's recorded decision, or null before it is made. */
  final_decision?: { amount_lkr: number | null; reason: string | null; decided_at: string | null } | null;
  payment_authorized?: boolean;
  /** The account tail on the family's registration, or null when they have given none. */
  bank_account_last4?: string | null;
}

export type DsFailure =
  | { reason: "config" }
  | { reason: "no-session" }
  | { reason: "signed-out"; status: number; code: string }
  | { reason: "forbidden"; status: number; code: string }
  /** The account is a DS officer but carries no division claim — an administrator must fix it. */
  | { reason: "no-division"; status: number; code: string }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type DsCasesResult =
  | { ok: true; cases: DsCase[]; count: number; dsDivision: string }
  | { ok: false; failure: DsFailure };

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}

function classify(status: number, code: string): DsFailure {
  if (status === 401) return { reason: "signed-out", status, code };
  if (status === 403) {
    // Both are 403, and they mean opposite things to whoever reads the screen: one says "you are
    // not a DS officer", the other says "you are, but nobody assigned you a division".
    return code === "no_division_assigned"
      ? { reason: "no-division", status, code }
      : { reason: "forbidden", status, code };
  }
  return { reason: "server", status, code };
}

export async function fetchDsCases(statusFilter?: string): Promise<DsCasesResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "config" } };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    res = await fetch(`${API_BASE}/api/v1/ds/cases${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) return { ok: false, failure: classify(res.status, await errorCode(res)) };

  try {
    const data = (await res.json()) as {
      cases?: DsCase[];
      count?: number;
      ds_division?: string;
    };
    return {
      ok: true,
      cases: data.cases ?? [],
      count: data.count ?? 0,
      dsDivision: data.ds_division ?? "",
    };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
  }
}

// --- Payment authorisation (Story 8.6, FR-10.4) ---------------------------------------------
//
// This is the ONE call in the frontend that receives a full bank account number. It is a POST
// because revealing the number IS the act of authorising the payment — every reveal is a
// deliberate, server-audited action, never something a prefetch or a history restore can trigger.

export interface BankDetails {
  account_number: string;
  bank_name: string | null;
  branch: string | null;
  account_holder: string | null;
}

export interface PaymentAuthorization {
  canonical_id: string;
  household_ref: string;
  amount_lkr: number | null;
  authorized_at: string | null;
  bank_details: BankDetails;
}

export type PaymentFailure =
  | { reason: "not-found" }
  /** Final governance workflow: payment follows the recorded DS final decision, never precedes it. */
  | { reason: "final-decision-required" }
  | { reason: "not-approved"; status?: string }
  | { reason: "no-household" }
  | { reason: "no-bank-details"; householdRef?: string }
  /** Stored ciphertext could not be decrypted. NOT the same as "the family gave none" — telling
   *  the officer that would send them to collect details the family already provided. */
  | { reason: "unreadable" }
  | { reason: "forbidden" }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type PaymentResult =
  | { ok: true; authorization: PaymentAuthorization }
  | { ok: false; failure: PaymentFailure };

export async function authorizePayment(canonicalId: string): Promise<PaymentResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "server", status: 0, code: "config" } };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "forbidden" } };

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/v1/ds/cases/${encodeURIComponent(canonicalId)}/authorize-payment`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) {
    let body: { error?: string; status?: string; household_ref?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* fall through to the generic server failure below */
    }
    const code = body.error ?? "";
    if (res.status === 404) return { ok: false, failure: { reason: "not-found" } };
    if (res.status === 403) return { ok: false, failure: { reason: "forbidden" } };
    if (code === "not_approved") {
      return { ok: false, failure: { reason: "not-approved", status: body.status } };
    }
    if (code === "no_household") return { ok: false, failure: { reason: "no-household" } };
    if (code === "final_decision_required") {
      return { ok: false, failure: { reason: "final-decision-required" } };
    }
    if (code === "no_bank_details") {
      return { ok: false, failure: { reason: "no-bank-details", householdRef: body.household_ref } };
    }
    if (code === "bank_details_unreadable") return { ok: false, failure: { reason: "unreadable" } };
    return { ok: false, failure: { reason: "server", status: res.status, code } };
  }

  try {
    return { ok: true, authorization: (await res.json()) as PaymentAuthorization };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
  }
}

// --- Final compensation decision (final governance workflow) ---------------------------------
//
// The human decision on the amount. The backend requires a reason whenever the amount differs
// from the AI-assisted estimate, records the decision in the audit trail and notifies the family.

export interface FinalDecision {
  amount_lkr: number;
  reason: string | null;
  decided_at: string | null;
  is_final_decision: true;
  revised: boolean;
  unchanged: boolean;
}

export type FinalDecisionFailure =
  | { reason: "reason-required" }
  | { reason: "invalid-amount" }
  | { reason: "not-approved"; status?: string }
  | { reason: "payment-authorized" }
  | { reason: "no-payment-record" }
  | { reason: "not-found" }
  | { reason: "forbidden" }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type FinalDecisionResult =
  | { ok: true; decision: FinalDecision; aiEstimate: number | null; dwcAmount: number | null }
  | { ok: false; failure: FinalDecisionFailure };

export async function recordFinalDecision(
  canonicalId: string,
  amountLkr: number,
  reason: string | null,
): Promise<FinalDecisionResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "forbidden" } };

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/v1/ds/cases/${encodeURIComponent(canonicalId)}/final-decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount_lkr: amountLkr, reason }),
      },
    );
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (res.ok && body.final_decision && typeof body.final_decision === "object") {
    return {
      ok: true,
      decision: body.final_decision as FinalDecision,
      aiEstimate: typeof body.ai_estimate_lkr === "number" ? body.ai_estimate_lkr : null,
      dwcAmount: typeof body.dwc_approved_amount_lkr === "number" ? body.dwc_approved_amount_lkr : null,
    };
  }

  const code = typeof body.error === "string" ? body.error : "";
  if (res.status === 404) return { ok: false, failure: { reason: "not-found" } };
  if (res.status === 401 || res.status === 403) return { ok: false, failure: { reason: "forbidden" } };
  if (code === "reason_required") return { ok: false, failure: { reason: "reason-required" } };
  if (code === "invalid_amount") return { ok: false, failure: { reason: "invalid-amount" } };
  if (code === "not_approved") {
    return { ok: false, failure: { reason: "not-approved", status: typeof body.status === "string" ? body.status : undefined } };
  }
  if (code === "payment_already_authorized") return { ok: false, failure: { reason: "payment-authorized" } };
  if (code === "no_payment_authorization") return { ok: false, failure: { reason: "no-payment-record" } };
  return { ok: false, failure: { reason: "server", status: res.status, code } };
}

// --- Bank details, recorded by the office that pays -------------------------------------------
//
// A citizen may add an account they skipped at registration, but never replace one already on file
// (households.py): whoever held their session could otherwise redirect the compensation. Correcting
// a mistyped or closed account therefore happens here, with a written reason.

export interface BankDetailsInput {
  account_number: string;
  bank_name?: string;
  branch?: string;
  account_holder?: string;
}

export type BankDetailsFailure =
  | { reason: "not-found" }
  | { reason: "reason-required" }
  | { reason: "invalid-bank" }
  | { reason: "forbidden" }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type BankDetailsResult =
  | { ok: true; householdRef: string; last4: string | null; replacedExisting: boolean }
  | { ok: false; failure: BankDetailsFailure };

export async function setHouseholdBankDetails(
  householdRef: string,
  bank: BankDetailsInput,
  reason: string,
): Promise<BankDetailsResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "server", status: 0, code: "config" } };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "forbidden" } };

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/v1/households/${encodeURIComponent(householdRef)}/bank-details`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bank, reason }),
      },
    );
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (res.ok) {
    return {
      ok: true,
      householdRef: typeof body.household_ref === "string" ? body.household_ref : householdRef,
      last4: typeof body.bank_account_last4 === "string" ? body.bank_account_last4 : null,
      replacedExisting: body.replaced_existing === true,
    };
  }

  const code = typeof body.error === "string" ? body.error : "";
  if (res.status === 404) return { ok: false, failure: { reason: "not-found" } };
  if (res.status === 401 || res.status === 403) return { ok: false, failure: { reason: "forbidden" } };
  if (code === "reason_required") return { ok: false, failure: { reason: "reason-required" } };
  if (code === "invalid_bank_details") return { ok: false, failure: { reason: "invalid-bank" } };
  return { ok: false, failure: { reason: "server", status: res.status, code } };
}
