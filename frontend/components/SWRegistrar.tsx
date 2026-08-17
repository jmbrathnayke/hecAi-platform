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
    // @serwist/next is disabled in `next dev` (see next.config.ts), so only register in
    // production. Note /sw.js DOES exist in dev — `npm run build` writes it into public/ — so
    // registering here would install a production SW over a dev server.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Service Worker registration failed:", err);
      });
    }

    // In development, actively TEAR DOWN any Service Worker still registered on this origin.
    //
    // Disabling serwist in dev only stops a NEW worker being installed; a worker registered by an
    // earlier production build on the same origin (localhost:3000) keeps controlling the page and
    // keeps answering from its precache. That is not hypothetical: it served a months-old
    // MobileNetV2 export for hours while the dev server had the corrected one on disk, and made a
    // fixed model look broken on the machine it was fixed on.
    //
    // A dev server must never be fronted by a production cache, so unregister and drop the caches.
    // Reload once afterwards, guarded by a session flag, because the page currently on screen was
    // itself served by the worker being removed.
    if (process.env.NODE_ENV !== "production" && "serviceWorker" in navigator) {
      void (async () => {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          if (registrations.length === 0) return;
          await Promise.all(registrations.map((r) => r.unregister()));
          if (typeof caches !== "undefined") {
            await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
          }
          console.warn(
            `[SWRegistrar] removed ${registrations.length} stale Service Worker registration(s) ` +
              "and cleared Cache Storage — a dev server must not be served from a production cache.",
          );
          if (!sessionStorage.getItem("hec-sw-purged")) {
            sessionStorage.setItem("hec-sw-purged", "1");
            location.reload();
          }
        } catch (err) {
          console.error("[SWRegistrar] failed to remove stale Service Worker:", err);
        }
      })();
    }

    // Initialize IndexedDB (creates the object stores on first run) — needed in all envs.
    openDB().catch((err) => {
      console.error("IndexedDB initialization failed:", err);
    });
  }, []);

  return null;
}
