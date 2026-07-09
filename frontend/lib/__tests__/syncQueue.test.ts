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
import { enqueueCase, getLastSyncedAt, getQueuedItems, retryItem, runSync } from "@/lib/syncQueue";

jest.mock("@/lib/indexeddb", () => ({
  addSyncQueueItem: jest.fn(),
  deleteSyncQueueItem: jest.fn(),
  getSessionValue: jest.fn(),
  getSyncQueue: jest.fn(),
  putSessionValue: jest.fn(),
  updateDraft: jest.fn(),
  updateSyncQueueItem: jest.fn(),
}));

const mockAdd = addSyncQueueItem as jest.Mock;
const mockDelete = deleteSyncQueueItem as jest.Mock;
const mockGetQueue = getSyncQueue as jest.Mock;
const mockGetSessionValue = getSessionValue as jest.Mock;
const mockPutSessionValue = putSessionValue as jest.Mock;
const mockUpdateDraft = updateDraft as jest.Mock;
const mockUpdateItem = updateSyncQueueItem as jest.Mock;

function item(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return {
    id: 1,
    offline_id: "off-1",
    payload: { offline_id: "off-1" },
    status: "pending",
    sync_attempts: 0,
    queued_at: 1000,
    next_attempt_at: 0, // due by default
    ...overrides,
  };
}

beforeEach(() => {
  mockAdd.mockReset().mockResolvedValue(1);
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockGetQueue.mockReset().mockResolvedValue([]);
  mockGetSessionValue.mockReset().mockResolvedValue(undefined);
  mockPutSessionValue.mockReset().mockResolvedValue(undefined);
  mockUpdateDraft.mockReset().mockResolvedValue(undefined);
  mockUpdateItem.mockReset().mockResolvedValue(undefined);
  (global.fetch as jest.Mock | undefined)?.mockReset?.();
});

afterEach(() => {
  // jest.spyOn(window, "dispatchEvent") in the tests below would otherwise keep
  // accumulating call history across tests (spyOn on an already-spied function
  // returns the same mock rather than a fresh one).
  jest.restoreAllMocks();
});

describe("enqueueCase", () => {
  it("adds a new pending item when none exists for the offline_id", async () => {
    mockGetQueue.mockResolvedValue([]);
    await enqueueCase("off-1", { offline_id: "off-1" });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [added] = mockAdd.mock.calls[0];
    expect(added).toMatchObject({ offline_id: "off-1", status: "pending", sync_attempts: 0 });
  });

  it("is a no-op when any item for the same offline_id is already queued (pending, in_progress, or failed)", async () => {
    mockGetQueue.mockResolvedValue([item({ status: "failed" })]);
    await enqueueCase("off-1", { offline_id: "off-1" });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("getLastSyncedAt", () => {
  it("returns null when nothing has synced yet", async () => {
    mockGetSessionValue.mockResolvedValue(undefined);
    expect(await getLastSyncedAt()).toBeNull();
  });

  it("returns the persisted timestamp", async () => {
    mockGetSessionValue.mockResolvedValue({ id: "sync_last_synced_at", synced_at: 12345 });
    expect(await getLastSyncedAt()).toBe(12345);
  });
});

describe("getQueuedItems", () => {
  it("delegates to getSyncQueue", async () => {
    mockGetQueue.mockResolvedValue([item()]);
    expect(await getQueuedItems()).toEqual([item()]);
  });
});

describe("runSync", () => {
  it("does nothing when the queue is empty", async () => {
    mockGetQueue.mockResolvedValue([]);
    await runSync("tok");
    expect(global.fetch).toBeUndefined();
  });

  it("skips items whose backoff window has not elapsed", async () => {
    mockGetQueue.mockResolvedValue([item({ next_attempt_at: Date.now() + 60_000 })]);
    global.fetch = jest.fn();
    await runSync("tok");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POSTs due items as a batch and clears them on confirmed success", async () => {
    const due = item({ id: 5, offline_id: "off-5" });
    mockGetQueue.mockResolvedValue([due]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ offline_id: "off-5", canonical_id: "HEC-2026-0099" }] }),
    }) as unknown as typeof fetch;

    await runSync("tok-abc");

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/api/v1/sync/batch");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-abc");
    expect(JSON.parse(init.body)).toEqual({ cases: [due.payload] });

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      "off-5",
      expect.objectContaining({ canonical_id: "HEC-2026-0099", sync_status: "synced" }),
    );
    expect(mockDelete).toHaveBeenCalledWith(5);
    expect(mockPutSessionValue).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sync_last_synced_at", synced_at: expect.any(Number) }),
    );
  });

  it("records a failed attempt (not terminal) when the server doesn't confirm an item", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 2, sync_attempts: 0 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;

    await runSync("tok");

    expect(mockDelete).not.toHaveBeenCalled();
    // Each item is first marked in_progress, then updated again with the failure outcome —
    // take the LAST call for the id to read the terminal state of this attempt.
    const failureUpdate = mockUpdateItem.mock.calls.filter(([, fields]) => "sync_attempts" in fields).pop();
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate?.[1]).toMatchObject({ status: "pending", sync_attempts: 1 });
    expect(failureUpdate?.[1].next_attempt_at).toBeGreaterThan(Date.now());
  });

  it("increments sync_attempts for all due items on an HTTP error response", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 3, sync_attempts: 2 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    await runSync("tok");

    const failureUpdate = mockUpdateItem.mock.calls.filter(([id]) => id === 3).pop();
    expect(failureUpdate?.[1]).toMatchObject({ status: "pending", sync_attempts: 3, last_error: "HTTP 500" });
  });

  it("increments sync_attempts on a network error", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 4 })]);
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    await runSync("tok");

    const failureUpdate = mockUpdateItem.mock.calls.filter(([id]) => id === 4).pop();
    expect(failureUpdate?.[1]).toMatchObject({ status: "pending", sync_attempts: 1, last_error: "offline" });
  });

  it("marks an item failed once attempts exceed 5", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 9, sync_attempts: 5 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    await runSync("tok");

    const failureUpdate = mockUpdateItem.mock.calls.filter(([id]) => id === 9).pop();
    expect(failureUpdate?.[1]).toMatchObject({ status: "failed", sync_attempts: 6 });
  });

  it("dispatches a hec-case-synced event with the offline_id/canonical_id on confirmed success", async () => {
    const due = item({ id: 5, offline_id: "off-5" });
    mockGetQueue.mockResolvedValue([due]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ offline_id: "off-5", canonical_id: "HEC-2026-0099" }] }),
    }) as unknown as typeof fetch;
    const dispatchSpy = jest.spyOn(window, "dispatchEvent");

    await runSync("tok");

    const synced = dispatchSpy.mock.calls
      .map(([e]) => e as CustomEvent)
      .find((e) => e.type === "hec-case-synced");
    expect(synced).toBeDefined();
    expect(synced?.detail).toEqual({ offline_id: "off-5", canonical_id: "HEC-2026-0099" });
  });

  it("does not dispatch hec-case-synced for an item the server didn't confirm", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 2 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;
    const dispatchSpy = jest.spyOn(window, "dispatchEvent");

    await runSync("tok");

    const synced = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).find((e) => e.type === "hec-case-synced");
    expect(synced).toBeUndefined();
  });

  it("does not fire two overlapping batches when called concurrently", async () => {
    // The re-entrancy guard (module-level `syncInFlight`) is set synchronously at the top
    // of runSync, before its first await — so calling it twice back-to-back (no await in
    // between) must always produce exactly one fetch, regardless of how fast it resolves.
    mockGetQueue.mockResolvedValue([item()]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;

    const first = runSync("tok");
    const second = runSync("tok");
    await Promise.all([first, second]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("retryItem", () => {
  it("throws when the queue item no longer exists", async () => {
    mockGetQueue.mockResolvedValue([]);
    await expect(retryItem(1, "tok")).rejects.toThrow("Queue item not found");
    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it("marks the item in_progress optimistically before the request resolves", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 7, status: "failed" })]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ offline_id: "off-1", canonical_id: "HEC-2026-0100" }] }),
    }) as unknown as typeof fetch;

    await retryItem(7, "tok");

    expect(mockUpdateItem.mock.calls[0]).toEqual([7, { status: "in_progress" }]);
  });

  it("sends only the single retried item's payload, not the whole queue", async () => {
    const target = item({ id: 7, offline_id: "off-7", payload: { offline_id: "off-7" } });
    mockGetQueue.mockResolvedValue([target, item({ id: 8, offline_id: "off-8" })]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ offline_id: "off-7", canonical_id: "HEC-2026-0100" }] }),
    }) as unknown as typeof fetch;

    await retryItem(7, "tok-xyz");

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/api/v1/sync/batch");
    expect(init.headers.Authorization).toBe("Bearer tok-xyz");
    expect(JSON.parse(init.body)).toEqual({ cases: [target.payload] });
  });

  it("on confirmed success: updates the draft, deletes the queue row, records last-synced, and dispatches hec-case-synced", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 7, offline_id: "off-7" })]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ offline_id: "off-7", canonical_id: "HEC-2026-0100" }] }),
    }) as unknown as typeof fetch;
    const dispatchSpy = jest.spyOn(window, "dispatchEvent");

    await retryItem(7, "tok");

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      "off-7",
      expect.objectContaining({ canonical_id: "HEC-2026-0100", sync_status: "synced" }),
    );
    expect(mockDelete).toHaveBeenCalledWith(7);
    expect(mockPutSessionValue).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sync_last_synced_at", synced_at: expect.any(Number) }),
    );
    const synced = dispatchSpy.mock.calls
      .map(([e]) => e as CustomEvent)
      .find((e) => e.type === "hec-case-synced");
    expect(synced?.detail).toEqual({ offline_id: "off-7", canonical_id: "HEC-2026-0100" });
  });

  it("on HTTP error: marks the item failed immediately (does not reschedule with backoff) and rethrows", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 7, sync_attempts: 1 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    await expect(retryItem(7, "tok")).rejects.toThrow("HTTP 500");

    const failureUpdate = mockUpdateItem.mock.calls.at(-1);
    expect(failureUpdate).toEqual([7, { status: "failed", sync_attempts: 2, last_error: "HTTP 500" }]);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("on network error: marks the item failed with the error message and rethrows", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 7, sync_attempts: 0 })]);
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    await expect(retryItem(7, "tok")).rejects.toThrow("offline");

    const failureUpdate = mockUpdateItem.mock.calls.at(-1);
    expect(failureUpdate).toEqual([7, { status: "failed", sync_attempts: 1, last_error: "offline" }]);
  });

  it("when the server doesn't confirm the item: marks it failed rather than silently succeeding", async () => {
    mockGetQueue.mockResolvedValue([item({ id: 7, offline_id: "off-7", sync_attempts: 0 })]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;

    await expect(retryItem(7, "tok")).rejects.toThrow("not confirmed by server");

    const failureUpdate = mockUpdateItem.mock.calls.at(-1);
    expect(failureUpdate).toEqual([7, { status: "failed", sync_attempts: 1, last_error: "not confirmed by server" }]);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
