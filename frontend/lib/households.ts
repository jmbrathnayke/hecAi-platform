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

export interface RegisterHouseholdInput {
  nic: string;
  full_name?: string;
  district: string;
  ds_division: string;
  gn_division?: string;
  members: HouseholdMemberInput[];
}

export interface Household {
  household_ref: string;
  district: string;
  ds_division: string;
  gn_division: string | null;
  status: string;
  registered_at: string | null;
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
  | { reason: "invalid-form"; code: string }
  | { reason: "no-session" }
  | { reason: "forbidden" }
  | { reason: "config" }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" };

export type RegisterResult =
  | { ok: true; householdRef: string; district: string; dsDivision: string; memberCount: number }
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
    };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status, code: "bad_response" } };
  }
}

/** The signed-in citizen's household, or null when they have none (or we cannot ask). */
export async function getMyHousehold(): Promise<Household | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return null;
  }
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/households/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Household;
  } catch {
    return null;
  }
}
