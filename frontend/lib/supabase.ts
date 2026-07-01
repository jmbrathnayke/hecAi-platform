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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, key);
}

/**
 * Server-side client for middleware/Server Components. `cookies` must implement the
 * subset of the Next.js cookie store `@supabase/ssr` needs (get/set/remove or getAll/setAll
 * depending on version) — callers pass an adapter appropriate to their context.
 */
export function createServerSupabaseClient(cookies: CookieMethodsServer) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createServerClient(url, key, { cookies });
}
