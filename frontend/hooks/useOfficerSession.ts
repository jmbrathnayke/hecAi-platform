"use client";

// Officer session hook (Story 3.1). Reads the Supabase session for display/UX purposes only
// (officer_id, assigned_divisions shown in the UI) — this is NOT the security boundary.
// Per CRITICAL #2, the backend independently re-validates the JWT on every request; nothing
// read here is trusted for access control.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { getSessionValue, putSessionValue } from "@/lib/indexeddb";

const OFFICER_SESSION_KEY = "officer";

export interface OfficerSessionState {
  officer_id: string | null;
  assigned_divisions: string[];
  loading: boolean;
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
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!mountedRef.current) return;

        if (!error && data.session) {
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

        // No live session (e.g. offline) — fall back to the last cached session so an
        // officer mid-field-visit isn't locked out of context by a dropped connection.
        const cached = await getSessionValue(OFFICER_SESSION_KEY);
        if (!mountedRef.current) return;
        if (cached) {
          setState({
            officer_id: (cached.officer_id as string) ?? null,
            assigned_divisions: Array.isArray(cached.assigned_divisions)
              ? (cached.assigned_divisions as string[])
              : [],
            loading: false,
          });
        } else {
          setState({ officer_id: null, assigned_divisions: [], loading: false });
        }
      } catch {
        // getSession()/IDB failure — never leave the hook stuck on loading forever.
        if (mountedRef.current) {
          setState({ officer_id: null, assigned_divisions: [], loading: false });
        }
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return state;
}
