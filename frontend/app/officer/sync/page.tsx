"use client";
// Sync Queue screen (Story 4.4, FR-8.4/8.5, UX-DR11). The officer's safety net after
// BackgroundSync/SyncStatusBar auto-retry exhausts its attempts: full visibility into every
// queued item plus a manual, immediate retry. English-only officer route (FR-9.3, no
// next-intl — same convention as SyncStatusBar/dashboard/classify).
import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "@/lib/auth";
import { getLastSyncedAt, getQueuedItems, retryItem } from "@/lib/syncQueue";
import type { SyncQueueItem } from "@/lib/indexeddb";
import { SyncQueueItemCard } from "@/components/SyncQueueItem";
import { Toast } from "@/components/Toast";

const POLL_MS = 5_000;

/** Cheap signature of the fields the UI actually renders — used to skip a re-render when a
 * poll tick returns state that is unchanged (CRITICAL #4: avoid list jank every 5s). */
function signature(items: SyncQueueItem[]): string {
  return items
    .map((i) => `${i.id}:${i.status}:${i.sync_attempts}:${i.last_error ?? ""}`)
    .join("|");
}

/** Maps a retryItem() failure to a message that reflects its actual cause (2026-07-09 code
 * review), instead of a single generic "connection" string for every failure mode. */
function errorToastMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (message === "not confirmed by server") {
    return "Sync couldn't be confirmed. Try again or contact support.";
  }
  if (message.startsWith("HTTP")) {
    return "Server error. Try again in a moment.";
  }
  if (message.includes("already in progress")) {
    return "This report is already syncing.";
  }
  return "Retry failed. Check your connection.";
}

export default function SyncQueuePage() {
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
      setToastMsg("You are offline — retry when connected");
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setToastMsg("Retry failed. Check your connection.");
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
      setToastMsg("Report synced successfully");
    } catch (err) {
      setToastMsg(errorToastMessage(err));
    } finally {
      await refresh();
    }
  }

  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <div className="mx-auto max-w-2xl space-y-design-4">
        <h1 className="text-title text-ink-primary">Sync Queue</h1>

        {loadError ? (
          <div
            role="alert"
            className="rounded-md border border-status-error bg-status-error-pale px-design-4 py-design-4 text-label text-status-error"
          >
            Couldn&apos;t load the sync queue. Check your connection and try again.
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-design-12 gap-design-3" role="status">
            <span className="text-4xl" aria-hidden="true">
              ✓
            </span>
            <p className="text-heading text-forest">All reports synced</p>
            {lastSynced !== null && (
              <p className="text-label text-ink-disabled">
                Last sync: {new Date(lastSynced).toLocaleTimeString()}
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
