"use client";

// Admin inactivity timeout (Story 5.1, AC5/UX-DR19/UX-DR20). A separate, client-tracked idle
// timer layered over the admin Supabase JWT's own 4h expiry (architecture.md AD-4). Warns at
// 3h45m of inactivity, force-signs-out at 4h and redirects to /admin/login. Mirrors
// useSessionTimeout structurally at admin scope, with one addition: an optional
// `onBeforeTimeout` callback fired just before sign-out/redirect. This is the extensibility
// seam AC5's "unsaved state is preserved in sessionStorage" plugs into — no admin dashboard
// state exists to snapshot yet (that's Story 5.3's deliverable), so this story ships the seam,
// not a fabricated snapshot.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { deleteSessionValue } from "@/lib/indexeddb";
import { ADMIN_SESSION_KEY } from "./useAdminSession";

export const WARNING_AFTER_MS = 3 * 60 * 60 * 1000 + 45 * 60 * 1000; // 3h45m
export const TIMEOUT_AFTER_MS = 4 * 60 * 60 * 1000; // 4h

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ["mousedown", "keydown", "touchstart", "scroll"];

export interface AdminSessionTimeoutOptions {
  /** Called once, just before signOut()/redirect fires on idle expiry. Story 5.3 wires a real
   *  sessionStorage snapshot of in-progress admin form state in here (AC5). */
  onBeforeTimeout?: () => void;
}

export interface SessionTimeoutState {
  showWarning: boolean;
  /** Dismisses the warning and resets the inactivity clock (call on any admin acknowledgement). */
  extendSession: () => void;
}

export function useAdminSessionTimeout(options?: AdminSessionTimeoutOptions): SessionTimeoutState {
  const router = useRouter();
  const [showWarning, setShowWarning] = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards signOut()/navigation after the timer fires post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  // Bumped on every armTimers() call. The in-flight timeout callback captures its own
  // generation and checks it's still current before committing the redirect — activity
  // arriving after the 4h timer fires but before its async signOut() resolves can't be
  // cancelled via clearTimeout (the callback already started), so this catches it instead.
  const generationRef = useRef(0);
  // Hold the latest onBeforeTimeout in a ref so armTimers stays stable (identity-independent
  // of the caller passing a fresh inline callback each render).
  const onBeforeTimeoutRef = useRef(options?.onBeforeTimeout);
  onBeforeTimeoutRef.current = options?.onBeforeTimeout;

  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    warningTimerRef.current = null;
    timeoutTimerRef.current = null;
  }, []);

  const armTimers = useCallback(() => {
    clearTimers();
    const myGeneration = ++generationRef.current;
    warningTimerRef.current = setTimeout(() => {
      if (mountedRef.current && generationRef.current === myGeneration) setShowWarning(true);
    }, WARNING_AFTER_MS);
    timeoutTimerRef.current = setTimeout(() => {
      (async () => {
        // Snapshot seam (AC5): only fire if this generation is still current and mounted, so a
        // stale timer racing fresh activity doesn't trigger a spurious save.
        if (mountedRef.current && generationRef.current === myGeneration) {
          try {
            onBeforeTimeoutRef.current?.();
          } catch {
            // A snapshot failure must never block sign-out — expiry proceeds regardless.
          }
        }
        try {
          await createClient().auth.signOut();
        } catch {
          // Sign-out failure must not block the redirect — an expired session should not
          // leave the admin stranded on a protected page either way.
        } finally {
          // Best-effort: clear the cached admin identity (code review 2026-07-09) so a
          // shared/kiosk browser's offline fallback (useAdminSession) doesn't keep serving
          // this admin's admin_id/district_id after this forced sign-out. Runs regardless of
          // the generation check below — signOut() already happened either way.
          deleteSessionValue(ADMIN_SESSION_KEY).catch(() => {});
          // If activity re-armed the timers while signOut() was in flight, this callback
          // is stale — don't redirect an admin who's since become active again.
          if (mountedRef.current && generationRef.current === myGeneration) {
            setShowWarning(false);
            router.push("/admin/login");
          }
        }
      })();
    }, TIMEOUT_AFTER_MS);
  }, [clearTimers, router]);

  const extendSession = useCallback(() => {
    // Guard against being called after unmount (e.g. by a warning-modal button whose click
    // handler fires post-navigation) — re-arming here would start timers the unmount cleanup
    // already ran and will never clear again.
    if (!mountedRef.current) return;
    setShowWarning(false);
    armTimers();
  }, [armTimers]);

  useEffect(() => {
    mountedRef.current = true;
    armTimers();

    const onActivity = () => {
      // Any activity while the warning is showing counts as an explicit extension.
      armTimers();
      if (mountedRef.current) setShowWarning(false);
    };
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, onActivity, { passive: true }));

    return () => {
      mountedRef.current = false;
      clearTimers();
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, onActivity));
    };
    // Mount once; armTimers/clearTimers are stable via useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { showWarning, extendSession };
}
