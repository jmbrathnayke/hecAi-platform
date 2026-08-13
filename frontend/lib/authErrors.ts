/**
 * Maps the `?error=` codes app/auth/callback/route.ts emits onto i18n message keys.
 *
 * WHY THIS EXISTS (code review 2026-08-13). The callback redirects failures back to a login page
 * with `?error=<code>` — the route's own comment called it "a flag the page can surface" — but no
 * login page ever read the query string. An officer who declined Google's consent screen, or hit
 * a stale code, landed on a pristine login form with no message at all: a sign-in that silently
 * does nothing, which is the exact symptom the callback route was written to eliminate.
 *
 * Codes are mapped, never rendered. The route allowlists what it emits, and anything unrecognized
 * that still reaches here collapses to the generic key rather than being displayed — so a
 * hand-crafted /officer/login?error=<attacker text> link cannot put chosen words on our own login
 * page.
 */
const KEYS: Record<string, string> = {
  access_denied: "login.errorAccessDenied",
  missing_code: "login.errorMissingCode",
  exchange_failed: "login.errorExchangeFailed",
  unreachable: "login.networkError",
  server_error: "login.errorProvider",
  temporarily_unavailable: "login.errorProvider",
  oauth_error: "login.errorProvider",
};

/** Returns the i18n key for a callback error code, or null when there is nothing to show. */
export function callbackErrorKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return KEYS[raw] ?? "login.errorProvider";
}
