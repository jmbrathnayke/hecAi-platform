// Household registration state for the citizen app (FR-10.3 gate, final governance workflow).
//
// WHY THIS EXISTS. The old getMyHousehold() returned null for "no household", for "not signed in" AND for
// "the API could not be reached". The report page showed all three as "Register your family first",
// so a family that had registered was told to register again whenever the network dropped, and
// the registration page showed its form to a citizen who had already completed it. These are five
// different situations with five different right answers:
//
//   not-registered   the server said 404            -> register
//   registered       the server returned the family -> show it, and "Report New Incident"
//   unauthenticated  no session, or the server 401s -> sign in
//   unavailable      the check failed and we have no confirmed answer -> "retry"
//   registered (cached)  offline / unreachable, but THIS account's registration was confirmed by
//                    the server on an earlier visit -> continue with the confirmed state
//
// WHAT IS STORED LOCALLY, and what is not. Only the household REFERENCE (HH-YYYY-NNNN -- the family's
// working number, printed on their receipt) and the opaque account id it was confirmed for, so a
// second person signing in on the same phone never inherits it. Never a NIC, a name, a member list,
// a bank detail or an address: the registry holds only keyed digests of NICs and none of that is
// needed to decide whether to open the form. The server still enforces the gate on submission
// (403 not_registered); this cache only decides which screen to show while offline.
import { getAccessToken } from "@/lib/auth";
import { subjectFromToken } from "@/lib/jwtClaims";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export const REGISTRATION_CACHE_KEY = "hec-registration-confirmed";

export type RegistrationState =
  | {
      kind: "registered";
      householdRef: string;
      source: "server" | "cached";
      /** Present only from the server; the offline cache deliberately keeps the reference alone. */
      district?: string;
      dsDivision?: string;
    }
  | { kind: "not-registered" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

interface ConfirmedRegistration {
  v: 1;
  account: string;
  householdRef: string;
  confirmedAt: string;
}

const HOUSEHOLD_REF_RE = /^HH-\d{4}-\d+$/i;

/** The JWT `sub` (an opaque account id). Decoded without verification: it only keys a local cache. */
export function accountIdFromToken(token: string): string | null {
  return subjectFromToken(token);
}

export function readConfirmedRegistration(account: string): string | null {
  try {
    const raw = window.localStorage.getItem(REGISTRATION_CACHE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<ConfirmedRegistration>;
    if (record.v !== 1 || record.account !== account) return null;
    if (typeof record.householdRef !== "string" || !HOUSEHOLD_REF_RE.test(record.householdRef)) {
      return null;
    }
    return record.householdRef;
  } catch {
    return null;
  }
}

export function rememberRegistration(account: string, householdRef: string): void {
  if (!account || !HOUSEHOLD_REF_RE.test(householdRef)) return;
  const record: ConfirmedRegistration = {
    v: 1,
    account,
    householdRef,
    confirmedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(REGISTRATION_CACHE_KEY, JSON.stringify(record));
  } catch {
    // Storage blocked: the only cost is that an offline visit cannot use the confirmed state.
  }
}

export function forgetRegistration(): void {
  try {
    window.localStorage.removeItem(REGISTRATION_CACHE_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** Record a registration the server has just confirmed (registration success, or 409 own-account). */
export async function rememberRegistrationForCurrentAccount(householdRef: string): Promise<void> {
  const token = await getAccessToken();
  const account = token ? accountIdFromToken(token) : null;
  if (account) rememberRegistration(account, householdRef);
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function checkRegistration(): Promise<RegistrationState> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    // A build with no auth configuration cannot answer the question at all.
    return { kind: "unavailable" };
  }

  const token = await getAccessToken();
  if (!token) return { kind: "unauthenticated" };

  const account = accountIdFromToken(token);
  const cachedRef = account ? readConfirmedRegistration(account) : null;
  const fromCache = (): RegistrationState =>
    cachedRef
      ? { kind: "registered", householdRef: cachedRef, source: "cached" }
      : { kind: "unavailable" };

  if (isOffline()) return fromCache();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/households/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Transport failure is indistinguishable from being offline.
    return fromCache();
  }

  if (res.status === 404) {
    // The server's clean "no": anything remembered for this device is stale.
    forgetRegistration();
    return { kind: "not-registered" };
  }
  if (res.status === 401) return { kind: "unauthenticated" };
  // A 5xx is the server answering badly, not the network being down, so a remembered state is not
  // silently substituted for the server's answer: the citizen is asked to retry.
  if (!res.ok) return { kind: "unavailable" };

  try {
    const body = (await res.json()) as {
      household_ref?: unknown;
      district?: unknown;
      ds_division?: unknown;
    };
    if (typeof body.household_ref !== "string" || !body.household_ref) {
      return { kind: "unavailable" };
    }
    if (account) rememberRegistration(account, body.household_ref);
    return {
      kind: "registered",
      householdRef: body.household_ref,
      source: "server",
      ...(typeof body.district === "string" ? { district: body.district } : {}),
      ...(typeof body.ds_division === "string" ? { dsDivision: body.ds_division } : {}),
    };
  } catch {
    return { kind: "unavailable" };
  }
}
