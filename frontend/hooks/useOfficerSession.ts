"use client";

// Officer session hook (Story 3.1). Reads the Supabase session for display/UX purposes only
// (officer_id, assigned_divisions shown in the UI) — this is NOT the security boundary.
// Per CRITICAL #2, the backend independently re-validates the JWT on every request; nothing
// read here is trusted for access control.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { getSessionValue, putSessionValue } from "@/lib/indexeddb";

const OFFICER_SESSION_KEY = "officer";
const GET_SESSION_TIMEOUT_MS = 8000;

export interface OfficerSessionState {
  officer_id: string | null;
  assigned_divisions: string[];
  loading: boolean;
}

async function readCachedSession(): Promise<OfficerSessionState> {
  const cached = await getSessionValue(OFFICER_SESSION_KEY);
  if (!cached) return { officer_id: null, assigned_divisions: [], loading: false };
  return {
    officer_id: typeof cached.officer_id === "string" ? cached.officer_id : null,
    assigned_divisions: Array.isArray(cached.assigned_divisions)
      ? (cached.assigned_divisions as unknown[]).filter((d): d is string => typeof d === "string")
      : [],
    loading: false,
  };
}

export function useOfficerSession(): OfficerSessionState {
  const [state, setState] = useState<OfficerSessionState>({
    officer_id: null,
    assigned_divisions: [],
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
          // as the expected "no session" case — both fall through to the cache fallback below,
          // rather than only the latter (this hook's own stated purpose is offline availability
          // on ANY failure to establish a live session, not just a clean "no session" resolve).
          if (!error && data.session?.user?.id) {
            const metadata = data.session.user.user_metadata ?? {};
            const divisions: string[] = Array.isArray(metadata.assigned_divisions)
              ? metadata.assigned_divisions
              : [];
            const next = { officer_id: data.session.user.id, assigned_divisions: divisions };
            setState({ ...next, loading: false });
            // Best-effort offline cache — a write failure here must never block the UI.
            putSessionValue({ id: OFFICER_SESSION_KEY, ...next }).catch(() => {});
            return;
          }
        }

        // No live session, a malformed session, or a getSession() timeout — fall back to the
        // last cached session so an officer mid-field-visit isn't locked out of context by a
        // dropped connection.
        const fallback = await readCachedSession();
        if (mountedRef.current) setState(fallback);
      } catch {
        // getSession() rejection (e.g. network down) — this is the literal "dropped
        // connection" case the offline cache exists for, so it must attempt the same
        // fallback as the resolved-no-session path above, not just report signed-out.
        clearTimeout(timeoutId);
        try {
          const fallback = await readCachedSession();
          if (mountedRef.current) setState(fallback);
        } catch {
          if (mountedRef.current) {
            setState({ officer_id: null, assigned_divisions: [], loading: false });
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
