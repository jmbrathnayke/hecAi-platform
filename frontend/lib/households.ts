// Household registration API client (Story 8.2, FR-10.1/10.2).
//
// PII discipline. The NIC travels in PLAINTEXT to the server here, and that is deliberate — the
// server derives a keyed HMAC the client cannot compute (the pepper would have to ship to every
// browser) and discards the plaintext. See PRD Addendum A8.2. The consequence for this file: a
// NIC must never be written to IndexedDB, localStorage, sessionStorage, or a console line on the
// way. It goes from a React state variable straight into this fetch body and nowhere else.
//
// Failures are a discriminated union rather than a thrown Error, for the same reason the officer
// dashboard was changed on 2026-08-21: collapsing every non-ok response into one "it failed"
// state left the real cause visible only in DevTools. Here it matters more — "your family is
// already registered" and "the server is misconfigured" need completely different screens.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface HouseholdMemberInput {
  nic: string;
  full_name?: string;
  relationship?: string;
}

export interface BankDetailsInput {
  account_number: string;
  bank_name?: string;
  branch?: string;
  account_holder?: string;
}

export interface RegisterHouseholdInput {
  nic: string;
  full_name?: string;
  district: string;
  ds_division: string;
  gn_division?: string;
  /** Required from migration 035. Stored in the clear like contact_email; returned only to the family. */
  address: string;
  members: HouseholdMemberInput[];
  /**
   * Optional (FR-10.4). Sent in the clear over TLS and encrypted SERVER-side with a key the
   * browser never holds — the Divisional Secretariat has to be able to read the account to pay
   * it, so unlike the NIC this cannot be a one-way digest, and unlike the incident form's fields
   * it cannot use the per-device AES-GCM key (a desk in Thalawa cannot decrypt what a phone in a
   * village encrypted). Never persisted client-side: like the NICs, it lives in component state
   * only and is gone on unmount.
   */
  bank?: BankDetailsInput;
  /**
   * Optional. Where status notifications are emailed.
   *
   * Unlike the NIC and the bank account this is not sensitive enough to need special handling —
   * but it is the ONLY server-readable way to reach a citizen. The incident form's mobile number
   * is AES-GCM encrypted client-side with a non-extractable key, so the server can never read it
   * (see migration 020); an address given here is the one that works. Omitting it costs nothing:
   * the public status page needs no address, no login and no permission.
   */
  contact_email?: string;
  /**
   * Optional (migration 039). A mobile number the Divisional Secretariat office can phone, sent in
   * the canonical "+947XXXXXXXX" form (lib/validation.ts normaliseMobile). Nothing ever messages
   * it: SMS is retired, so this is a contact detail and not a notification channel.
   */
  contact_mobile?: string;
}

export interface Household {
  household_ref: string;
  district: string;
  ds_division: string;
  gn_division: string | null;
  status: string;
  registered_at: string | null;
  /** NULL for households registered before migration 035. */
  address: string | null;
  contact_email: string | null;
  bank_account_last4: string | null;
  /** "+947XXXXXXXX", or null when none was given. Absent from servers older than migration 039. */
  contact_mobile?: string | null;
  members: { full_name: string | null; relationship: string | null; is_registrant: boolean }[];
}

/**
 * Why the failure list is this shape:
 *  - `already-registered`  this ACCOUNT has a household. Carries its ref — it is the caller's own.
 *  - `nic-taken`           a NIC is occupied. `householdRef` is present ONLY when the clash is on
 *                          the registrant's own NIC; on a declared member the backend withholds it
 *                          so nobody learns which family a relative belongs to.
 *  - `invalid-*`           the form is wrong and the user can fix it here.
 *  - `config` / `server`   nothing the user did; retry only helps for `server`.
 */
export type RegisterFailure =
  | { reason: "already-registered"; householdRef: string }
  | { reason: "nic-taken"; scope: "registrant"; householdRef: string }
  | { reason: "nic-taken"; scope: "member" }
  | { reason: "invalid-nic" }
  | { reason: "invalid-division" }
  | { reason: "duplicate-nic-in-form" }
  | { reason: "invalid-bank" }
  | { reason: "invalid-form"; code: string }
  | { reason: "no-session" }
  | { reason: "forbidden" }
  | { reason: "config" }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type RegisterResult =
  | {
      ok: true;
      householdRef: string;
      district: string;
      dsDivision: string;
      memberCount: number;
      bankAccountLast4: string | null;
    }
  | { ok: false; failure: RegisterFailure };

/** The backend's `{"error": ...}` envelope, or {} when the body is not the shape we expect. */
async function errorBody(res: Response): Promise<{ error?: string; scope?: string; household_ref?: string }> {
  try {
    return (await res.json()) as { error?: string; scope?: string; household_ref?: string };
  } catch {
    return {};
  }
}

function classify(status: number, body: { error?: string; scope?: string; household_ref?: string }): RegisterFailure {
  const code = body.error ?? "";

  if (status === 409) {
    if (code === "already_registered") {
      return { reason: "already-registered", householdRef: body.household_ref ?? "" };
    }
    // A member-scoped clash deliberately carries no ref; treat a missing ref as member-scoped
    // rather than inventing an empty one for the UI to render.
    return body.scope === "registrant" && body.household_ref
      ? { reason: "nic-taken", scope: "registrant", householdRef: body.household_ref }
      : { reason: "nic-taken", scope: "member" };
  }
  if (status === 400) {
    if (code === "invalid_nic") return { reason: "invalid-nic" };
    if (code === "invalid_division") return { reason: "invalid-division" };
    if (code === "duplicate_nic_in_form") return { reason: "duplicate-nic-in-form" };
    if (code === "invalid_bank_details") return { reason: "invalid-bank" };
    return { reason: "invalid-form", code };
  }
  if (status === 401) return { reason: "no-session" };
  if (status === 403) return { reason: "forbidden" };
  return { reason: "server", status, code };
}

export async function registerHousehold(input: RegisterHouseholdInput): Promise<RegisterResult> {
  // Mirrors the guard inside getAccessToken(): it returns null both for "no session" and for
  // "this build has no Supabase keys". Told apart here so a missing env var is never reported as
  // a sign-in problem — sending someone to a login page that also cannot work.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "config" } };
  }

  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/households`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
  } catch {
    // fetch() rejects only on a transport failure. An HTTP error status resolves normally and is
    // classified below — different problems, different fixes.
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) return { ok: false, failure: classify(res.status, await errorBody(res)) };

  try {
    const data = (await res.json()) as {
      household_ref?: string;
      district?: string;
      ds_division?: string;
      member_count?: number;
      bank_account_last4?: string | null;
    };
    if (!data.household_ref) {
      // 201 with no reference is not a success we can show anyone.
      return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
    }
    return {
      ok: true,
      householdRef: data.household_ref,
      district: data.district ?? input.district,
      dsDivision: data.ds_division ?? input.ds_division,
      memberCount: data.member_count ?? 1 + input.members.length,
      // The tail only — enough for the citizen to confirm they typed the right account, and the
      // most any surface but the DS payment view ever sees.
      bankAccountLast4: data.bank_account_last4 ?? null,
    };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
  }
}

// --- Officer registration in the field (migration 041) -----------------------------------------
//
// For the families an officer-assisted report exists for: no smartphone, so no account of their
// own to register with. The officer registers them on the spot; the household is PROVISIONAL until
// the Divisional Secretariat verifies it, and payment is held until then. The district is derived
// on the server from the division, and no bank details are sent: the family or the DS office
// records the account. The same NIC discipline as registerHousehold applies.

export interface OfficerRegisterInput {
  nic: string;
  full_name: string;
  ds_division: string;
  gn_division?: string;
  address: string;
  members: HouseholdMemberInput[];
  /** "+947XXXXXXXX" (lib/validation.ts normaliseMobile), when the officer has one. */
  contact_mobile?: string;
}

export type OfficerRegisterFailure =
  | RegisterFailure
  | { reason: "division-not-assigned" };

export type OfficerRegisterResult =
  | { ok: true; householdRef: string; district: string; dsDivision: string; provisional: boolean }
  | { ok: false; failure: OfficerRegisterFailure };

export async function registerHouseholdByOfficer(
  input: OfficerRegisterInput,
): Promise<OfficerRegisterResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "config" } };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/households/officer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) {
    const body = await errorBody(res);
    if (res.status === 403 && body.error === "division_not_assigned") {
      return { ok: false, failure: { reason: "division-not-assigned" } };
    }
    return { ok: false, failure: classify(res.status, body) };
  }

  try {
    const data = (await res.json()) as {
      household_ref?: string;
      district?: string;
      ds_division?: string;
      provisional?: boolean;
    };
    if (!data.household_ref) {
      return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
    }
    return {
      ok: true,
      householdRef: data.household_ref,
      district: data.district ?? "",
      dsDivision: data.ds_division ?? input.ds_division,
      provisional: data.provisional !== false,
    };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
  }
}

export interface HouseholdLookup {
  household_ref: string;
  district: string;
  ds_division: string;
}

export type LookupResult =
  | { status: "found"; household: HouseholdLookup }
  | { status: "not-registered" }
  /** Anything that is not a clean yes/no — the officer must not be told "not registered" on a
   *  network blip, because the correct action (send the family to the DS office) is wrong. */
  | { status: "error" };

/**
 * Look a citizen's household up by NIC, for the officer-assisted path (Story 8.5).
 *
 * Story 8.4 gated submission on a household reference, but the officer app cannot derive one: it
 * AES-GCM encrypts the citizen's NIC with a non-extractable device key, so the reference is
 * recoverable neither client-side nor from the stored ciphertext. This is the only way the
 * officer app can obtain it, and without it officer-assisted submission cannot complete.
 *
 * POST, so the NIC travels in a body rather than a URL — query strings reach access logs,
 * browser history and Referer headers.
 */
export async function lookupHousehold(nic: string): Promise<LookupResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { status: "error" };
  }
  const token = await getAccessToken();
  if (!token) return { status: "error" };

  try {
    const res = await fetch(`${API_BASE}/api/v1/households/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nic }),
    });
    if (res.status === 404) return { status: "not-registered" };
    if (!res.ok) return { status: "error" };
    const data = (await res.json()) as Partial<HouseholdLookup>;
    if (!data.household_ref || !data.district || !data.ds_division) return { status: "error" };
    return { status: "found", household: data as HouseholdLookup };
  } catch {
    return { status: "error" };
  }
}

/** What a family may change for itself (PATCH /households/me). Area and members are not here. */
export interface HouseholdChanges {
  address?: string;
  /** An empty string clears it. */
  contact_email?: string;
  /** "+947XXXXXXXX"; an empty string clears it. */
  contact_mobile?: string;
  gn_division?: string;
  /** Accepted only while no bank details are on file; the server refuses a replacement (409). */
  bank?: BankDetailsInput;
}

export type UpdateFailure =
  | { reason: "invalid-address" }
  | { reason: "invalid-email" }
  | { reason: "invalid-mobile" }
  | { reason: "invalid-bank" }
  | { reason: "bank-locked" }
  | { reason: "not-registered" }
  | { reason: "no-session" }
  | { reason: "network" }
  | { reason: "server"; status: number };

export type UpdateResult = { ok: true; household: Household } | { ok: false; failure: UpdateFailure };

export async function updateMyHousehold(changes: HouseholdChanges): Promise<UpdateResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, failure: { reason: "server", status: 0 } };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/households/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(changes),
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (res.ok) {
    try {
      const household = (await res.json()) as Household;
      if (household?.household_ref) return { ok: true, household };
    } catch {
      /* fall through to a server failure */
    }
    return { ok: false, failure: { reason: "server", status: res.status } };
  }

  const code = (await errorBody(res)).error ?? "";
  if (res.status === 400 && code === "missing_fields") return { ok: false, failure: { reason: "invalid-address" } };
  if (res.status === 400 && code === "invalid_email") return { ok: false, failure: { reason: "invalid-email" } };
  if (res.status === 400 && code === "invalid_mobile") return { ok: false, failure: { reason: "invalid-mobile" } };
  if (res.status === 400 && code === "invalid_bank_details") return { ok: false, failure: { reason: "invalid-bank" } };
  if (res.status === 409 && code === "bank_details_locked") return { ok: false, failure: { reason: "bank-locked" } };
  if (res.status === 404) return { ok: false, failure: { reason: "not-registered" } };
  if (res.status === 401) return { ok: false, failure: { reason: "no-session" } };
  return { ok: false, failure: { reason: "server", status: res.status } };
}

export type MyHouseholdResult =
  | { kind: "ok"; household: Household }
  | { kind: "not-registered" }
  | { kind: "unauthenticated" }
  | { kind: "error" };

/** The signed-in citizen's own household. "Not registered" and "could not ask" stay distinct. */
export async function fetchMyHousehold(): Promise<MyHouseholdResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { kind: "error" };
  }
  const token = await getAccessToken();
  if (!token) return { kind: "unauthenticated" };
  try {
    const res = await fetch(`${API_BASE}/api/v1/households/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { kind: "not-registered" };
    if (res.status === 401) return { kind: "unauthenticated" };
    if (!res.ok) return { kind: "error" };
    const household = (await res.json()) as Household;
    return household?.household_ref ? { kind: "ok", household } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}
