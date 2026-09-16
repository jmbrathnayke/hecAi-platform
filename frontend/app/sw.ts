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

// ---------------------------------------------------------------- Web Push
//
// Status notifications. The backend encrypts each payload to this browser's own subscription keys
// (app/infrastructure/push/), so what arrives here is readable by this install and nothing else.
//
// WHY PUSH AT ALL. SMS to Sri Lankan networks needs a sender identity registered with each
// operator, which needs a registered business entity — unavailable to this project (see §7.2 of
// the dissertation). Push has no such gate, and unlike SMS or email it needs no personal data:
// the subscription is an opaque endpoint, not a contact detail.

interface PushPayload {
  title?: string;
  body?: string;
  ref?: string;
  status?: string;
}

self.addEventListener("push", (event: PushEvent) => {
  // A push with no data is a valid wake-up, and some services send one to verify a subscription.
  // Falling back to a generic notification is required: Chrome shows its own "This site has been
  // updated in the background" message if a push event ends without showNotification().
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    // Not JSON — treat as an empty payload rather than failing the event.
  }

  const title = payload.title || "HEC";
  const ref = payload.ref ?? "";

  // `renotify` is in the Notifications spec and honoured by Chrome, but TypeScript's DOM lib does
  // not declare it. Widening the type is preferable to dropping the property: without it a second
  // status change on the same claim replaces the first card SILENTLY, and the citizen is never
  // alerted that their claim moved — which is the entire point of the notification.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Collapse repeat notifications for one claim: a citizen who is away for a day should come
    // back to the latest status, not five stacked cards describing the same claim's history.
    tag: ref ? `hec-case-${ref}` : "hec",
    renotify: Boolean(ref),
    data: { ref, status: payload.status ?? "" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const ref = (event.notification.data as { ref?: string } | undefined)?.ref;
  // The public status page needs no login (FR-6.1), so the notification stays actionable even
  // after the session has expired — which, for a claim that takes weeks, is the normal case.
  const target = ref ? `/status?ref=${encodeURIComponent(ref)}` : "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse an open tab rather than stacking a new one on every notification.
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(target).catch(() => undefined);
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
