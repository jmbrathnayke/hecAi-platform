"use client";
// Delivers citizen reports made offline, automatically (lib/citizenOutbox.ts).
//
// Mounted once in the citizen layout, so it runs on whichever citizen page is open: when the app
// starts, when the browser reports it is back online, when the tab becomes visible again, and on a
// slow interval as a backstop for browsers whose `online` event is unreliable. Each trigger is a
// cheap IndexedDB read when there is nothing due, and the outbox itself guards against overlap.
import { useEffect } from "react";
import { flushCitizenOutbox } from "@/lib/citizenOutbox";

export function CitizenSyncRunner({ intervalMs = 60_000 }: { intervalMs?: number }) {
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void flushCitizenOutbox().catch(() => {
        /* IndexedDB unavailable (private mode, SSR preview): nothing to deliver from here */
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };

    run();
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(run, intervalMs);

    return () => {
      cancelled = true;
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return null;
}
