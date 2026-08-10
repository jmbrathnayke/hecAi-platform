"use client";

// RER-7 measurement harness (2026-08-11). NOT a product feature.
//
// WHY THIS PAGE EXISTS. RER-7 asks for a >= 95% offline SUBMISSION COMPLETION RATE across three
// network conditions. That rate is a property of this tier -- the service worker, the IndexedDB
// sync_queue, and the exponential backoff in lib/syncQueue.ts -- and the backend scenario suite
// provably cannot measure it: a Flask test client has no service worker and cannot go offline.
// Measuring it needs a real browser with real IndexedDB under real network control, which is
// what e2e/rer7-offline.mjs drives through this page.
//
// WHAT IT DOES NOT DO. It exposes the REAL syncQueue exports -- it does not reimplement them.
// A reimplementation would measure the harness, not the artefact. It does, however, bypass the
// citizen form UI: it evidences that a queued case survives being offline and reaches the
// server, not that a user can complete the form. State that distinction when reporting.
//
// PRODUCTION SAFETY. Renders nothing and exposes nothing unless
// NEXT_PUBLIC_ENABLE_RER7_HARNESS === "1". The flag is read at build time by Next, so a normal
// production build has no window handle to reach even if the route is somehow served.

import { useEffect, useState } from "react";

import { getSyncQueue } from "@/lib/indexeddb";
import { enqueueCase, getQueuedItems, runSync } from "@/lib/syncQueue";

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_RER7_HARNESS === "1";

declare global {
  interface Window {
    __hecRer7?: {
      enqueue: (offlineId: string, payload: Record<string, unknown>) => Promise<void>;
      sync: (token: string) => Promise<void>;
      queued: () => Promise<unknown[]>;
      queueLength: () => Promise<number>;
      ready: true;
    };
  }
}

export default function Rer7HarnessPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ENABLED) return;
    window.__hecRer7 = {
      enqueue: enqueueCase,
      sync: runSync,
      queued: async () => getQueuedItems(),
      queueLength: async () => (await getSyncQueue()).length,
      ready: true,
    };
    setReady(true);
    return () => {
      delete window.__hecRer7;
    };
  }, []);

  if (!ENABLED) return null;
  // The runner waits for this exact text, so it never begins measuring against a page whose
  // effect has not run yet -- which would silently record "0 queued" as a real result.
  return <main data-testid="rer7-harness">{ready ? "rer7-harness-ready" : "rer7-harness-loading"}</main>;
}
