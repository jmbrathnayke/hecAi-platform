"use client";

// Admin session hook (Story 5.1). Reads the Supabase session for display/UX purposes only
// (admin_id, district_id shown in the UI) — this is NOT the security boundary. Per CRITICAL #2,
// the backend independently re-validates the JWT (require_admin()) on every request; nothing
// read here is trusted for access control. Mirrors useOfficerSession at district scope; reuses
// the same generic `officer_session` IDB store under a distinct cache key.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { getSessionValue, putSessionValue } from "@/lib/indexeddb";

export const ADMIN_SESSION_KEY = "admin";
const GET_SESSION_TIMEOUT_MS = 8000;

export interface AdminSessionState {
  admin_id: string | null;
  district_id: string | null;
  loading: boolean;
}

async function readCachedSession(): Promise<AdminSessionState> {
  const cached = await getSessionValue(ADMIN_SESSION_KEY);
  if (!cached) return { admin_id: null, district_id: null, loading: false };
  return {
    admin_id: typeof cached.admin_id === "string" ? cached.admin_id : null,
    district_id: typeof cached.district_id === "string" ? cached.district_id : null,
    loading: false,
  };
}

export function useAdminSession(): AdminSessionState {
  const [state, setState] = useState<AdminSessionState>({
    admin_id: null,
    district_id: null,
    loading: true,
  });
  // Guards state updates after getSession()/IDB resolve post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = createClient();

    (async () => {
      // A hung getSession() (e.g. a stalled network request) must not leave `loading: true`
      // forever — race it against a timeout that falls back to the offline cache instead.
      const TIMED_OUT = Symbol("getSession-timeout");
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timeoutId = setTimeout(() => resolve(TIMED_OUT), GET_SESSION_TIMEOUT_MS);
      });

      try {
        const result = await Promise.race([supabase.auth.getSession(), timeout]);
        clearTimeout(timeoutId);
        if (!mountedRef.current) return;

        if (result !== TIMED_OUT) {
          const { data, error } = result;
          // Guard against a malformed session (truthy but missing `user`/`user.id`) as well
          // as the expected "no session" case — both fall through to the cache fallback below.
          if (!error && data.session?.user?.id) {
            const metadata = data.session.user.app_metadata ?? {};
            const district_id =
              typeof metadata.district_id === "string" ? metadata.district_id : null;
            const next = { admin_id: data.session.user.id, district_id };
            setState({ ...next, loading: false });
            // Best-effort offline cache — a write failure here must never block the UI.
            putSessionValue({ id: ADMIN_SESSION_KEY, ...next }).catch(() => {});
            return;
          }
        }

        // No live session, a malformed session, or a getSession() timeout — fall back to the
        // last cached session so an admin isn't locked out of context by a dropped connection.
        const fallback = await readCachedSession();
        if (mountedRef.current) setState(fallback);
      } catch {
        // getSession() rejection (e.g. network down) — attempt the same cache fallback as the
        // resolved-no-session path above, not just report signed-out.
        clearTimeout(timeoutId);
        try {
          const fallback = await readCachedSession();
          if (mountedRef.current) setState(fallback);
        } catch {
          if (mountedRef.current) {
            setState({ admin_id: null, district_id: null, loading: false });
          }
        }
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return state;
}
