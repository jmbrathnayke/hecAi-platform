"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Reactive online/offline status via `useSyncExternalStore`.
 * - Client snapshot reads the real `navigator.onLine` on the FIRST client render (no
 *   post-mount flash for an offline first load).
 * - Server snapshot defaults to `true` (navigator is undefined during SSR).
 * Note: `navigator.onLine` is best-effort — it can report `true` on captive portals /
 * connected-but-no-internet networks.
 */
export function useOnlineStatus(): { isOnline: boolean } {
  const isOnline = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return { isOnline };
}
