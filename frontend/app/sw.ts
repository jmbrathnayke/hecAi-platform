// Serwist Service Worker (serwist v9 API).
// Compiled by @serwist/next from this TypeScript source into public/sw.js at build time.
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { BackgroundSyncPlugin, NetworkOnly, Serwist } from "serwist";

// The build injects the precache manifest (app shell + additionalPrecacheEntries) here.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // App shell + manifest.json + icons (see additionalPrecacheEntries in next.config.ts).
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // defaultCache adds runtime caching for the Next.js app, static assets, and
  // Google Fonts (google-fonts-stylesheets / google-fonts-webfonts) — this is what
  // makes the Noto Sans Sinhala + Tamil subsets available offline after the first visit.
  runtimeCaching: [
    ...defaultCache,
    // Story 4.1: defense-in-depth for a closed/backgrounded tab. The app-level sync_queue
    // (lib/syncQueue.ts) is the source of truth for retry bookkeeping/UI; this plugin lets
    // the browser's native Background Sync replay the raw request even if the tab that
    // queued it isn't open when connectivity returns (Chrome/Android only — other browsers
    // fall back to the app-level `online` listener + poll in SyncStatusBar).
    {
      matcher: /\/api\/v1\/sync\/batch$/,
      method: "POST",
      handler: new NetworkOnly({
        plugins: [new BackgroundSyncPlugin("hec-sync-queue", { maxRetentionTime: 24 * 60 })],
      }),
    },
  ],
});

serwist.addEventListeners();
