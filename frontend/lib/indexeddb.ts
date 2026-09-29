// IndexedDB schema + helpers for the HEC offline store.
// CLIENT-ONLY: never import this from a Server Component — `indexedDB` exists only in the browser.
//
// Schema (version 2) — this is the permanent contract; changing it later requires a
// version bump + migration in onupgradeneeded.
//   cases           keyPath: offline_id   index: sync_status
//   sync_queue      keyPath: id (autoIncrement)   index: status
//   photo_blobs     keyPath: blob_key
//   officer_session keyPath: id
//
// v1 -> v2 (Story 4.1): sync_queue recreated with an inline `id` keyPath (was a bare
// autoIncrement key not stored on the record) so queue items can be read/updated by id
// without a cursor. Safe: no code wrote to sync_queue before this version.

const DB_NAME = "hec-platform-db";
const DB_VERSION = 2;

let dbInstance: IDBDatabase | null = null;
let openPromise: Promise<IDBDatabase> | null = null;

/**
 * Open (or return the already-open) IndexedDB connection.
 * Singleton: repeated calls resolve to the same IDBDatabase instance, and a single
 * in-flight open request is shared so concurrent callers don't race.
 */
export function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB is not available (openDB must run in the browser, not on the server)."),
    );
  }
  if (dbInstance) return Promise.resolve(dbInstance);
  if (openPromise) return openPromise;

  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const upgradeTx = (event.target as IDBOpenDBRequest).transaction;

      // If the upgrade transaction aborts (e.g. quota exceeded mid-create), reject so we
      // don't leave a half-created schema at DB_VERSION that later opens never retry.
      if (upgradeTx) {
        upgradeTx.onabort = () => {
          openPromise = null;
          reject(upgradeTx.error ?? new Error("IndexedDB upgrade transaction aborted"));
        };
      }

      if (!db.objectStoreNames.contains("cases")) {
        const casesStore = db.createObjectStore("cases", { keyPath: "offline_id" });
        casesStore.createIndex("sync_status", "sync_status", { unique: false });
      }

      // Recreated (not gated behind objectStoreNames.contains) on every v1->v2 upgrade to
      // change the key structure — see the v1->v2 note above. onupgradeneeded only runs once
      // per version bump per browser, so this never touches an already-v2 database.
      if (db.objectStoreNames.contains("sync_queue")) {
        db.deleteObjectStore("sync_queue");
      }
      const syncStore = db.createObjectStore("sync_queue", { keyPath: "id", autoIncrement: true });
      syncStore.createIndex("status", "status", { unique: false });

      if (!db.objectStoreNames.contains("photo_blobs")) {
        db.createObjectStore("photo_blobs", { keyPath: "blob_key" });
      }

      if (!db.objectStoreNames.contains("officer_session")) {
        db.createObjectStore("officer_session", { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      // If another tab triggers a version upgrade, close this connection so it isn't blocked.
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        openPromise = null;
      };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      openPromise = null;
      reject((event.target as IDBOpenDBRequest).error);
    };

    // Fires when an existing connection in another tab blocks this open/upgrade. Without
    // this handler neither onsuccess nor onerror fire and the promise would hang forever.
    request.onblocked = () => {
      openPromise = null;
      reject(new Error("IndexedDB open is blocked by another open connection (close other tabs)."));
    };
  });

  return openPromise;
}

// ---------------------------------------------------------------------------
// Internal: open a transaction, reopening the connection once if it was closed
// out from under us (e.g. by `onversionchange` in another tab → InvalidStateError).
// ---------------------------------------------------------------------------
async function openStore(
  storeName: string,
  mode: IDBTransactionMode,
): Promise<{ tx: IDBTransaction; store: IDBObjectStore }> {
  const db = await openDB();
  try {
    const tx = db.transaction(storeName, mode);
    return { tx, store: tx.objectStore(storeName) };
  } catch (err) {
    if (err instanceof DOMException && err.name === "InvalidStateError") {
      // Connection was closed; drop the stale singleton and reopen fresh, then retry once.
      dbInstance = null;
      openPromise = null;
      const reopened = await openDB();
      const tx = reopened.transaction(storeName, mode);
      return { tx, store: tx.objectStore(storeName) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Typed wrappers — stubs for now; expanded with real record types in Stories 2.x / 4.x.
// ---------------------------------------------------------------------------

export async function putCase(caseRecord: Record<string, unknown>): Promise<void> {
  const { tx, store } = await openStore("cases", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.put(caseRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getCase(offlineId: string): Promise<Record<string, unknown> | undefined> {
  const { store } = await openStore("cases", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(offlineId);
    req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCases(): Promise<Record<string, unknown>[]> {
  const { store } = await openStore("cases", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// sync_queue store (Story 4.1, FR-8.2/8.4/8.5) — cases that failed a one-shot online
// submit (or were drafted offline) wait here for automatic background retry. Bookkeeping
// (attempts/backoff/status) lives on the record so the SyncStatusBar and the retry loop
// share a single source of truth.
// ---------------------------------------------------------------------------

// A successfully-synced item is deleted outright (see runSync in lib/syncQueue.ts), never
// transitioned to a terminal "synced"/"done" state — so the status union only lists states
// an item can actually be found IN while it still exists in the store.
export interface SyncQueueItem {
  id: number;
  offline_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "in_progress" | "failed";
  sync_attempts: number;
  last_error?: string;
  queued_at: number;
  next_attempt_at: number;
}

export async function addSyncQueueItem(item: Omit<SyncQueueItem, "id">): Promise<number> {
  const { tx, store } = await openStore("sync_queue", "readwrite");
  return new Promise<number>((resolve, reject) => {
    const req = store.add(item);
    req.onsuccess = () => resolve(req.result as number);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  const { store } = await openStore("sync_queue", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as SyncQueueItem[]);
    req.onerror = () => reject(req.error);
  });
}

/** Read-merge-write a queue item by id. A no-op if the item was already removed. */
export async function updateSyncQueueItem(
  id: number,
  fields: Partial<Omit<SyncQueueItem, "id">>,
): Promise<void> {
  const { tx, store } = await openStore("sync_queue", "readwrite");
  return new Promise<void>((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const existing = req.result as SyncQueueItem | undefined;
      if (existing) store.put({ ...existing, ...fields, id });
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteSyncQueueItem(id: number): Promise<void> {
  const { tx, store } = await openStore("sync_queue", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// officer_session store — small keyed records (e.g. the citizen device crypto key).
// CryptoKey objects are stored directly via structured clone (never as raw bytes).
// ---------------------------------------------------------------------------

export async function getSessionValue(
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const { store } = await openStore("officer_session", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function putSessionValue(
  record: { id: string } & Record<string, unknown>,
): Promise<void> {
  const { tx, store } = await openStore("officer_session", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteSessionValue(id: string): Promise<void> {
  const { tx, store } = await openStore("officer_session", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Merge `fields` into an existing case draft (read-merge-write in one transaction).
 * Creates a minimal record if the draft does not yet exist.
 */
export async function updateDraft(
  offlineId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { tx, store } = await openStore("cases", "readwrite");
  return new Promise<void>((resolve, reject) => {
    const req = store.get(offlineId);
    req.onsuccess = () => {
      const existing = (req.result as Record<string, unknown> | undefined) ?? {
        offline_id: offlineId,
      };
      store.put({
        ...existing,
        ...fields,
        offline_id: offlineId,
        // Preserve a caller-/record-supplied status; only default to "draft" for a new record.
        sync_status: fields.sync_status ?? existing.sync_status ?? "draft",
        updated_at: new Date().toISOString(),
      });
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// AI classification (Story 3.3) — persisted onto the case draft. The `cases` store is
// schemaless (arbitrary record), so no version bump is needed; this typed helper exists to
// centralize the exact field names, which are a cross-story contract: Story 3.4 (override)
// reads `ai_category`/`ai_confidence` and copies `ai_category` into `original_ai_category`,
// and the sync path forwards these to inference_log.
// ---------------------------------------------------------------------------

export interface CaseClassification {
  ai_category: string; // raw model classId: crop_damage | no_damage | property_damage
  ai_confidence: number; // 0..1
  ai_severity: string; // None | Minor | Moderate | Severe
  ai_processing_time_ms: number;
  ai_model_version: string;
  case_category?: string; // derived case-level rollup (crop_damage|property_damage|combined|no_damage)

  // Open-set gate (lib/oodGate.ts). Optional, because a draft written before the gate existed
  // must still sync, and because `ai_category` already carries the SERVED class either way —
  // these only record how it was reached. Without them an offline-submitted case would lose the
  // distinction between "the model recognised undamaged land" and "the model recognised nothing",
  // which is the whole reason the gate writes a flag rather than silently changing the class.
  ai_gate_version?: string;
  ai_gate_applied?: boolean;
  ai_out_of_domain?: boolean;
  ai_domain_distance?: number | null;
  ai_raw_prediction?: string | null; // what the closed-set softmax said, when it was discarded
  ai_raw_confidence?: number | null;
}

export async function saveClassification(
  offlineId: string,
  classification: CaseClassification,
): Promise<void> {
  return updateDraft(offlineId, { ...classification });
}

// ---------------------------------------------------------------------------
// District / DS-division picker (Story 5.2, Task 7) — additive, optional fields on the
// case draft. Set directly via `putCase`/`updateDraft` at the two call sites that own
// location capture (`app/[locale]/report/location/page.tsx`'s `saveAndNext`,
// `app/officer/submit/page.tsx`'s `saveLocation`) rather than through a dedicated save
// helper, since both already write `location_lat`/`location_lng` in the same call.
// `district`/`ds_division` are the picker's direct output (Sinhala strings matching the
// RF compensation model's own training vocabulary) — see `DistrictPicker`/`compensation.py`.
// ---------------------------------------------------------------------------

export interface CaseLocation {
  district?: string;
  ds_division?: string;
}

// ---------------------------------------------------------------------------
// AI classification override (Story 3.4, FR-2.4) — additive audit fields on the case draft.
// The override is *additive*: `ai_category`/`ai_confidence`/`ai_severity` are never mutated;
// `original_ai_category` snapshots the AI's class at override time so the original prediction
// (and the override-rate metric, NFR-6.3) is always recoverable. `override_applied` is the
// FE-side contract name — the backend maps it to `inference_log.was_overridden` on sync
// (Story 4.2). Category values stay raw snake_case `ClassId` end-to-end.
// ---------------------------------------------------------------------------

export interface CaseOverride {
  override_applied: boolean; // officer overrode the AI class
  override_category: string; // corrected ClassId: crop_damage | no_damage | property_damage
  override_reason: string; // mandatory justification (>= 10 non-whitespace chars, UX-DR14)
  original_ai_category: string; // snapshot of ai_category at override time — ai_category stays intact
  case_category?: string; // recomputed case-level rollup after the override
}

export async function saveOverride(
  offlineId: string,
  override: CaseOverride,
): Promise<void> {
  return updateDraft(offlineId, { ...override });
}

// ---------------------------------------------------------------------------
// photo_blobs store — large image Blobs kept OUT of the cases record (the draft
// only references them by blob_key) to keep case-record sizes small.
// ---------------------------------------------------------------------------

export async function addPhotoBlob(blobKey: string, blob: Blob): Promise<void> {
  const { tx, store } = await openStore("photo_blobs", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.put({ blob_key: blobKey, blob, created_at: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deletePhotoBlob(blobKey: string): Promise<void> {
  const { tx, store } = await openStore("photo_blobs", "readwrite");
  return new Promise<void>((resolve, reject) => {
    store.delete(blobKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listPhotoBlobs(
  blobKeys: string[],
): Promise<{ blob_key: string; blob: Blob }[]> {
  if (blobKeys.length === 0) return [];
  const { store } = await openStore("photo_blobs", "readonly");
  const results = await Promise.all(
    blobKeys.map(
      (key) =>
        new Promise<{ blob_key: string; blob: Blob } | undefined>((resolve, reject) => {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result as { blob_key: string; blob: Blob } | undefined);
          req.onerror = () => reject(req.error);
        }),
    ),
  );
  return results.filter((r): r is { blob_key: string; blob: Blob } => r !== undefined);
}
