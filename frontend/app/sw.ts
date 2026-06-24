// Serwist Service Worker (serwist v9 API).
// Compiled by @serwist/next from this TypeScript source into public/sw.js at build time.
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

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
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
