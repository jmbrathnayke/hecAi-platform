"use client";

import { useEffect } from "react";
import { openDB } from "@/lib/indexeddb";

/**
 * Client-only bootstrap:
 *  - registers the serwist Service Worker (/sw.js) for offline app-shell caching
 *  - opens IndexedDB so the four object stores are created on first visit
 *
 * Renders nothing. Mounted once from the locale layout so the layout itself stays a Server Component.
 */
export function SWRegistrar() {
  useEffect(() => {
    // The SW is disabled in `next dev` (see next.config.ts), so `/sw.js` does not exist
    // there — only register in production to avoid a 404 + console error every dev load.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Service Worker registration failed:", err);
      });
    }

    // Initialize IndexedDB (creates the object stores on first run) — needed in all envs.
    openDB().catch((err) => {
      console.error("IndexedDB initialization failed:", err);
    });
  }, []);

  return null;
}
