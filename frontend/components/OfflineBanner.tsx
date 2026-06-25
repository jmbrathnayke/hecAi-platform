"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Toast } from "@/components/Toast";

// Survives a reconnect that reloads the page (the PWA re-syncs on regaining network).
// The flag is set while offline and only cleared when the reconnect toast is dismissed —
// so it can still be replayed if the reconnect triggers a page reload.
const WAS_OFFLINE_KEY = "hec-was-offline";

/**
 * Sticky offline banner + reconnect toast.
 * - Shows a sticky amber banner (role="alert", aria-live="polite") while offline.
 * - On offline→online, fires a 3s "Back online" toast — even when reconnect reloads the
 *   page (intent persisted in sessionStorage, replayed on mount).
 * - Slide-down animation is suppressed under prefers-reduced-motion (UX-DR15).
 */
export function OfflineBanner() {
  const { isOnline } = useOnlineStatus();
  const t = useTranslations("offline");
  const prevOnline = useRef(true);
  const [showToast, setShowToast] = useState(false);

  // Replay the reconnect toast after a reconnect-triggered reload. Clear the flag as soon as
  // it's consumed so a later unrelated reload can't replay a spurious toast.
  useEffect(() => {
    try {
      if (navigator.onLine && sessionStorage.getItem(WAS_OFFLINE_KEY)) {
        sessionStorage.removeItem(WAS_OFFLINE_KEY);
        setShowToast(true);
      }
    } catch {
      // sessionStorage unavailable (private mode) — non-fatal.
    }
  }, []);

  useEffect(() => {
    if (!isOnline) {
      // Remember offline so the reconnect toast survives a possible reload.
      try {
        sessionStorage.setItem(WAS_OFFLINE_KEY, "1");
      } catch {
        /* ignore */
      }
    } else if (!prevOnline.current) {
      // Reconnected within the same page session (no reload).
      setShowToast(true);
    }
    prevOnline.current = isOnline;
  }, [isOnline]);

  // Stable identity so the Toast's auto-dismiss timer isn't reset on every parent re-render.
  const dismissToast = useCallback(() => {
    setShowToast(false);
    try {
      sessionStorage.removeItem(WAS_OFFLINE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <>
      {!isOnline && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="offline-banner"
          className="sticky top-0 z-50 w-full bg-amber px-design-4 py-design-2 text-center text-label text-ink-on-amber animate-slide-down motion-reduce:animate-none"
        >
          {t("banner")}
        </div>
      )}
      {showToast && (
        <Toast message={t("reconnected")} duration={3000} onDismiss={dismissToast} />
      )}
    </>
  );
}
