// Supabase clients for officer/admin auth (Story 3.1). Citizen flows stay anonymous
// (lib/auth.ts getAccessToken already builds its own transient browser client).
//
// Two clients, two contexts:
// - createClient(): browser-side, used by client components (login page, session hooks).
// - createServerSupabaseClient(): server-side (middleware, Server Components), reads/writes
//   the auth cookies Supabase sets so the session survives navigation and SSR.
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieMethodsServer } from "@supabase/ssr";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // A missing env var here means a deployment misconfiguration, not a recoverable
    // runtime state — fail loudly and immediately rather than letting the Supabase SDK
    // fail confusingly later with `createBrowserClient(undefined, undefined)`.
    throw new Error(`${name} is not set — Supabase auth cannot initialize.`);
  }
  return value;
}

export function createClient() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createBrowserClient(url, key);
}

/**
 * Server-side client for middleware/Server Components. `cookies` must implement the
 * `CookieMethodsServer` shape (`getAll`/`setAll`) that this project's pinned `@supabase/ssr`
 * version (^0.5.0) requires — callers pass an adapter appropriate to their context.
 */
export function createServerSupabaseClient(cookies: CookieMethodsServer) {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createServerClient(url, key, { cookies });
}
