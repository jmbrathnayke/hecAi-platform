// IndexedDB schema + helpers for the HEC offline store.
// CLIENT-ONLY: never import this from a Server Component — `indexedDB` exists only in the browser.
//
// Schema (version 1) — this is the permanent contract; changing it later requires a
// version bump + migration in onupgradeneeded.
//   cases           keyPath: offline_id   index: sync_status
//   sync_queue      autoIncrement         index: status
//   photo_blobs     keyPath: blob_key
//   officer_session keyPath: id

const DB_NAME = "hec-platform-db";
const DB_VERSION = 1;

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

      if (!db.objectStoreNames.contains("sync_queue")) {
        const syncStore = db.createObjectStore("sync_queue", { autoIncrement: true });
        syncStore.createIndex("status", "status", { unique: false });
      }

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
        sync_status: "draft",
        updated_at: new Date().toISOString(),
      });
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
