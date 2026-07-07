"use client";

// Officer inactivity timeout (Story 3.1, AC6). This is a separate, shorter, client-tracked
// idle timer layered on top of the Supabase JWT's own 8h expiry (architecture.md AD-4) — it
// is NOT read from the token's `exp` claim. Warns at 3h45m of inactivity, force-signs-out at
// 4h. In-progress form drafts are untouched (IndexedDB `cases` records are keyed by
// offline_id, not by session, so they survive sign-out).
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

export const WARNING_AFTER_MS = 3 * 60 * 60 * 1000 + 45 * 60 * 1000; // 3h45m
export const TIMEOUT_AFTER_MS = 4 * 60 * 60 * 1000; // 4h

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ["mousedown", "keydown", "touchstart", "scroll"];

export interface SessionTimeoutState {
  showWarning: boolean;
  /** Dismisses the warning and resets the inactivity clock (call on any officer acknowledgement). */
  extendSession: () => void;
}

export function useSessionTimeout(): SessionTimeoutState {
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
        try {
          await createClient().auth.signOut();
        } catch {
          // Sign-out failure must not block the redirect — an expired session should not
          // leave the officer stranded on a protected page either way.
        } finally {
          // If activity re-armed the timers while signOut() was in flight, this callback
          // is stale — don't redirect an officer who's since become active again.
          if (mountedRef.current && generationRef.current === myGeneration) {
            setShowWarning(false);
            router.push("/officer/login");
          }
        }
      })();
    }, TIMEOUT_AFTER_MS);
  }, [clearTimers, router]);

  const extendSession = useCallback(() => {
    // Guard against being called after unmount (e.g. by a future warning-modal button
    // whose click handler fires post-navigation) — re-arming here would start timers that
    // the unmount cleanup already ran and will never clear again.
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
