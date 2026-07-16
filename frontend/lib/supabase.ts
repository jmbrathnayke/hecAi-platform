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

