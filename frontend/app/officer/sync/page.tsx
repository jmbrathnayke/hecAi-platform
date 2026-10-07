"use client";
// Sync Queue screen (Story 4.4, FR-8.4/8.5, UX-DR11). The officer's safety net after
// BackgroundSync/SyncStatusBar auto-retry exhausts its attempts: full visibility into every
// queued item plus a manual, immediate retry. Localized si/ta/en (Story 6.2, FR-9.1) via the
// officer i18n provider (Story 6.1) — strings from `officer.syncPage`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { getLastSyncedAt, getQueuedItems, retryItem } from "@/lib/syncQueue";
import type { SyncQueueItem } from "@/lib/indexeddb";
import { SyncQueueItemCard } from "@/components/SyncQueueItem";
import { Toast } from "@/components/Toast";
import { OfficerTopBar } from "@/components/OfficerTopBar";
import { CheckCircle } from "@phosphor-icons/react";

const POLL_MS = 5_000;

/** Cheap signature of the fields the UI actually renders — used to skip a re-render when a
 * poll tick returns state that is unchanged (CRITICAL #4: avoid list jank every 5s). */
function signature(items: SyncQueueItem[]): string {
  return items
    .map((i) => `${i.id}:${i.status}:${i.sync_attempts}:${i.last_error ?? ""}`)
    .join("|");
}

/** Maps a retryItem() failure to the `officer.syncPage.*` message key that reflects its actual
 * cause (2026-07-09 code review), instead of a single generic "connection" string for every
 * failure mode. Returns a key so the component can translate it in the active locale. */
function errorToastKey(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (message === "not confirmed by server") {
    return "syncPage.errorNotConfirmed";
  }
  if (message.startsWith("HTTP")) {
    return "syncPage.errorServer";
  }
  if (message.includes("already in progress")) {
    return "syncPage.errorInProgress";
  }
  return "syncPage.retryFailed";
}

export default function SyncQueuePage() {
  const t = useTranslations("officer");
  const locale = useLocale();
  const [items, setItems] = useState<SyncQueueItem[]>([]);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const lastSignatureRef = useRef<string>("");

  const refresh = useCallback(async () => {
    // A real IndexedDB read failure must surface as an error, not silently render as "queue
    // is empty" — this screen's whole purpose is being the officer's safety net (2026-07-09
    // code review). getLastSyncedAt() already fails safe internally (resolves to null), so in
    // practice only getQueuedItems() can reject here.
    let queue: SyncQueueItem[];
    let syncedAt: number | null;
    try {
      [queue, syncedAt] = await Promise.all([getQueuedItems(), getLastSyncedAt()]);
    } catch {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setLastSynced(syncedAt);
    const nextSignature = signature(queue);
    if (nextSignature === lastSignatureRef.current) return;
    lastSignatureRef.current = nextSignature;
    setItems(queue);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleRetry(id: number) {
    if (!navigator.onLine) {
      setToastMsg(t("syncPage.offlineRetry"));
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setToastMsg(t("syncPage.retryFailed"));
      return;
    }

    // Optimistic UI (AC2 / CRITICAL #2): reflect the in-flight retry immediately. This also
    // hides the Retry button for this item (canRetry only allows pending/failed), which is
    // what actually prevents a UI double-tap from firing a second retryItem() call —
    // lib/syncQueue.ts's own retryInFlight guard is the second, race-proof layer underneath.
    setItems((prev) => {
      const next = prev.map((i) => (i.id === id ? { ...i, status: "in_progress" as const } : i));
      lastSignatureRef.current = signature(next);
      return next;
    });

    try {
      await retryItem(id, token);
      setToastMsg(t("syncPage.syncedSuccess"));
    } catch (err) {
      setToastMsg(t(errorToastKey(err)));
    } finally {
      await refresh();
    }
  }

  return (
    <main className="flex-1 bg-surface-base">
      <OfficerTopBar label={t("syncPage.title")} />

      <div className="mx-auto max-w-2xl space-y-design-4 px-design-4 py-design-5">
        {loadError ? (
          <div
            role="alert"
            className="rounded-md border border-status-error bg-status-error-pale px-design-4 py-design-4 text-label text-status-error"
          >
            {t("syncPage.loadError")}
          </div>
        ) : items.length === 0 ? (
          // was py-design-12 / text-heading — neither exists in the theme (spacing tops out at
          // design-8; the type scale has no `heading`), so both were no-ops.
          <div className="flex flex-col items-center justify-center gap-design-3 py-design-8" role="status">
            <span className="flex h-14 w-14 items-center justify-center rounded-md bg-forest-pale text-forest" aria-hidden="true">
              <CheckCircle size={30} weight="fill" />
            </span>
            <p className="text-headline text-forest">{t("syncPage.allSynced")}</p>
            {lastSynced !== null && (
              <p className="text-label text-ink-disabled">
                {t("syncPage.lastSync", { time: new Date(lastSynced).toLocaleTimeString(locale) })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-design-3">
            {items.map((item) => (
              <SyncQueueItemCard key={item.id} item={item} onRetry={handleRetry} />
            ))}
          </div>
        )}
      </div>

      {toastMsg && <Toast message={toastMsg} duration={3000} onDismiss={() => setToastMsg(null)} />}
    </main>
  );
}
