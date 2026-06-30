// Returns the current Supabase access token, or null when there is no authenticated
// session (anonymous citizens). Officer/admin sessions land in Stories 3.1 / 5.1; once
// a session exists this enables the online PoC submission path. Safe to call anywhere:
// returns null if Supabase env is unconfigured or anything throws.
export async function getAccessToken(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  try {
    const { createBrowserClient } = await import("@supabase/ssr");
    const supabase = createBrowserClient(url, anon);
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
