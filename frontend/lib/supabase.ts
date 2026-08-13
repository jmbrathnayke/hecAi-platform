// Supabase clients for officer/admin auth (Story 3.1). Citizen flows stay anonymous
// (lib/auth.ts getAccessToken already builds its own transient browser client).
//
// Two clients, two contexts:
// - createClient(): browser-side, used by client components (login page, session hooks).
// - createServerSupabaseClient(): server-side (middleware, Server Components), reads/writes
//   the auth cookies Supabase sets so the session survives navigation and SSR.
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieMethodsServer } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // A missing env var here means a deployment misconfiguration, not a recoverable
    // runtime state — fail loudly and immediately rather than letting the Supabase SDK
    // fail confusingly later with `createBrowserClient(undefined, undefined)`.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set — Supabase auth cannot initialize."
    );
  }
  return createBrowserClient(url, key);
}

/**
 * Is the Supabase Auth service actually reachable?
 *
 * Exists specifically for the OAuth redirect path. `signInWithOAuth()` makes NO network call —
 * it only builds the provider URL and hands the browser to `window.location` — so it returns
 * `{ error: null }` even when the Auth host is unreachable, and the caller's try/catch can
 * never fire. The user is then dropped on a browser-level DNS/connection error page having
 * seen no message from the app at all.
 *
 * Password sign-in does not need this: `signInWithPassword()` does fetch, so it already
 * surfaces a failure through the normal error path.
 *
 * THIS IS A HINT, NOT A GATE (code review 2026-08-13). `fetch()` rejects with an
 * indistinguishable TypeError for DNS failure, TLS failure, a CORS policy rejection, an
 * ad-blocker or privacy extension, a corporate proxy, and an AbortError from our own timeout.
 * The distinction this function's contract wants — "transport failed" vs "host answered" — is
 * simply not observable cross-origin, so a `false` cannot be trusted enough to block a sign-in:
 * one browser extension would otherwise lock an officer out of a perfectly healthy Supabase.
 * `mode: "no-cors"` removes the CORS class of false negatives (an opaque response still
 * resolves), and callers must treat the result as advisory — warn, then attempt the sign-in
 * anyway. See the shared handler in both login pages.
 */
export async function isAuthReachable(timeoutMs = 5000): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${url}/auth/v1/health`, {
      method: "GET",
      mode: "no-cors",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side client for middleware/Server Components. `cookies` must implement the
 * `CookieMethodsServer` shape (`getAll`/`setAll`) that this project's pinned `@supabase/ssr`
 * version (^0.5.0) requires — callers pass an adapter appropriate to their context.
 */
export function createServerSupabaseClient(cookies: CookieMethodsServer) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set — Supabase auth cannot initialize."
    );
  }
  return createServerClient(url, key, { cookies });
}

