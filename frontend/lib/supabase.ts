// Supabase clients for officer/admin auth (Story 3.1). Citizen flows stay anonymous
// (lib/auth.ts getAccessToken already builds its own transient browser client).
//
// Two clients, two contexts:
// - createClient(): browser-side, used by client components (login page, session hooks).
// - createServerSupabaseClient(): server-side (middleware, Server Components), reads/writes
//   the auth cookies Supabase sets so the session survives navigation and SSR.
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieMethodsServer } from "@supabase/ssr";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/**
 * Server-side client for middleware/Server Components. `cookies` must implement the
 * subset of the Next.js cookie store `@supabase/ssr` needs (get/set/remove or getAll/setAll
 * depending on version) — callers pass an adapter appropriate to their context.
 */
export function createServerSupabaseClient(cookies: CookieMethodsServer) {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, { cookies });
}
