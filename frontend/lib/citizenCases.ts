// Citizen "My Cases" client (Story 4.0).
//
// WHY THIS MODULE EXISTS. The page used a three-value state — loading / error / ready — so four
// different things arrived on screen as one sentence: "Couldn't load your cases", offered with a
// Retry button. One of those four is having no session at all, and for that one Retry can never
// succeed. A citizen who is simply signed out is told the system is broken and handed a button
// that fails every time they press it.
//
// Failures are a discriminated union for the same reason lib/dsCases.ts and lib/households.ts use
// one: "sign in again" and "the server is down" need different words and different buttons, and
// collapsing them throws away the only information that tells the reader what to do.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface CitizenCase {
  canonical_id: string | null;
  offline_id: string | null;
  status: string;
  damage_category: string | null;
  submitted_via: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

export type CitizenFailure =
  /** No session in the browser at all — the visitor has not signed in, or signed out elsewhere. */
  | { reason: "no-session" }
  /** A session existed but the server rejected it: expired, or revoked since it was issued. */
  | { reason: "signed-out"; status: number }
  /** Reachable, but refusing or failing. Retrying is reasonable. */
  | { reason: "server"; status: number }
  /** Never reached the server: offline, DNS, blocked. Retrying is reasonable. */
  | { reason: "network" };

export type CitizenCasesResult =
  | { ok: true; cases: CitizenCase[] }
  | { ok: false; failure: CitizenFailure };

/** Retrying only helps where the obstacle can clear on its own. A missing session cannot. */
export function isRetryable(failure: CitizenFailure): boolean {
  return failure.reason === "server" || failure.reason === "network";
}

/** Whether the reader has to authenticate before anything else can work. */
export function needsSignIn(failure: CitizenFailure): boolean {
  return failure.reason === "no-session" || failure.reason === "signed-out";
}

export async function fetchMyCases(): Promise<CitizenCasesResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/citizen/cases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (res.status === 401) {
    // Distinct from no-session: the browser HELD a token and the server would not accept it, which
    // is what an expired session looks like and is worth saying plainly.
    return { ok: false, failure: { reason: "signed-out", status: res.status } };
  }
  if (!res.ok) return { ok: false, failure: { reason: "server", status: res.status } };

  try {
    const body = (await res.json()) as { cases?: CitizenCase[] };
    return { ok: true, cases: body.cases ?? [] };
  } catch {
    // A 200 whose body is not the shape promised is a server fault, not an empty case list —
    // rendering "you have no reports yet" here would tell a citizen their claims had vanished.
    return { ok: false, failure: { reason: "server", status: res.status } };
  }
}
