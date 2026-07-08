// Background sync queue (Story 4.1, FR-8.2/8.4/8.5). A case that fails a one-shot online
// submit (or was drafted while offline) is enqueued here and retried automatically with
// exponential backoff, until it either succeeds or exhausts MAX_ATTEMPTS — at which point
// it surfaces as "failed" for the SyncStatusBar (Story 4.4 owns the full review/manual-retry
// screen; this story only needs the notification, per its Build Files).
//
// POST /api/v1/sync/batch is the forward-declared contract Story 4.2 implements; until that
// ships, batches fail closed (network/404) and simply retry on schedule like any other
// failure — this queue does not assume the endpoint already exists.
import {
  addSyncQueueItem,
  deleteSyncQueueItem,
  getSessionValue,
  getSyncQueue,
  putSessionValue,
  updateDraft,
  updateSyncQueueItem,
  type SyncQueueItem,
} from "@/lib/indexeddb";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000; // 30s, doubling: 30/60/120/240/480

// A confirmed sync deletes its sync_queue row outright (see runSync below) rather than
// leaving a "synced" record behind, so "when did we last sync" can't be read off the queue
// itself — it's tracked separately here, in the small keyed officer_session store.
const LAST_SYNCED_SESSION_KEY = "sync_last_synced_at";

function backoffMs(attemptNumber: number): number {
  return BASE_BACKOFF_MS * 2 ** (attemptNumber - 1);
}

/**
 * Queue a case for background sync. Idempotent per offline_id: calling this again for a
 * case that is already queued (and not yet exhausted) is a no-op, so callers can enqueue
 * on every failed one-shot submit attempt without creating duplicate queue entries.
 */
export async function enqueueCase(
  offlineId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const existing = await getSyncQueue();
  const already = existing.some((item) => item.offline_id === offlineId);
  if (already) return;
  await addSyncQueueItem({
    offline_id: offlineId,
    payload,
    status: "pending",
    sync_attempts: 0,
    queued_at: Date.now(),
    next_attempt_at: Date.now(),
  });
}

export async function getQueuedItems(): Promise<SyncQueueItem[]> {
  return getSyncQueue();
}

/** Last time any item was confirmed synced, or null if nothing has synced yet this device. */
export async function getLastSyncedAt(): Promise<number | null> {
  const record = await getSessionValue(LAST_SYNCED_SESSION_KEY).catch(() => undefined);
  const value = record?.synced_at;
  return typeof value === "number" ? value : null;
}

async function recordLastSyncedNow(): Promise<void> {
  await putSessionValue({ id: LAST_SYNCED_SESSION_KEY, synced_at: Date.now() }).catch(() => {});
}

let syncInFlight = false;

/**
 * Attempt to sync every due item (not already terminal, backoff window elapsed) in a
 * single batch request. Safe to call repeatedly and concurrently — a no-op when nothing
 * is due, and re-entrancy-guarded so overlapping callers (the `online` event and the
 * status-bar poll tick) never fire two batches at once.
 */
export async function runSync(jwtToken: string): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const items = await getSyncQueue();
    const now = Date.now();
    const due = items.filter((item) => item.status !== "failed" && item.next_attempt_at <= now);
    if (due.length === 0) return;

    await Promise.all(due.map((item) => updateSyncQueueItem(item.id, { status: "in_progress" })));

    try {
      const res = await fetch(`${API_BASE}/api/v1/sync/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwtToken}`,
        },
        body: JSON.stringify({ cases: due.map((item) => item.payload) }),
      });

      if (!res.ok) {
        await handleBatchFailure(due, `HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as {
        results?: { offline_id: string; canonical_id: string }[];
      };
      const canonicalByOfflineId = new Map((data.results ?? []).map((r) => [r.offline_id, r.canonical_id]));

      await Promise.all(
        due.map(async (item) => {
          const canonicalId = canonicalByOfflineId.get(item.offline_id);
          if (canonicalId) {
            await updateDraft(item.offline_id, {
              canonical_id: canonicalId,
              sync_status: "synced",
              synced_at: Date.now(),
            });
            await deleteSyncQueueItem(item.id);
            await recordLastSyncedNow();
            // Story 4.3: let an already-open PoC page pick up the canonical id live,
            // without waiting for a reload.
            window.dispatchEvent(
              new CustomEvent("hec-case-synced", {
                detail: { offline_id: item.offline_id, canonical_id: canonicalId },
              }),
            );
          } else {
            // The server didn't confirm this item — record it as a failed attempt rather
            // than silently dropping it (a partial-batch response must not look like success).
            await recordFailedAttempt(item, "not confirmed by server");
          }
        }),
      );
    } catch (err) {
      await handleBatchFailure(due, err instanceof Error ? err.message : "network error");
    }
  } finally {
    syncInFlight = false;
  }
}

async function handleBatchFailure(items: SyncQueueItem[], errorMessage: string): Promise<void> {
  await Promise.all(items.map((item) => recordFailedAttempt(item, errorMessage)));
}

async function recordFailedAttempt(item: SyncQueueItem, errorMessage: string): Promise<void> {
  const attempts = item.sync_attempts + 1;

  if (attempts > MAX_ATTEMPTS) {
    // No event dispatch here: SyncStatusBar derives the max-attempts notice directly from
    // status: "failed" in queue state, which this write makes true regardless of whether
    // anything is listening at this exact moment (a fresh mount later still sees it).
    await updateSyncQueueItem(item.id, { status: "failed", sync_attempts: attempts, last_error: errorMessage });
    return;
  }

  await updateSyncQueueItem(item.id, {
    status: "pending",
    sync_attempts: attempts,
    last_error: errorMessage,
    next_attempt_at: Date.now() + backoffMs(attempts),
  });
}
