/**
 * Citizen offline submission + automatic sync (final governance workflow).
 *
 * The officer path has synced itself since Story 4.1. These prove the citizen path now does too —
 * through the citizen's own idempotent endpoint, never the officer-only /sync/batch — and that a
 * report is delivered exactly once however many triggers fire.
 */
import {
  __resetCitizenOutboxForTests,
  flushCitizenOutbox,
  getPendingCitizenSubmissions,
  markCitizenSubmission,
} from "@/lib/citizenOutbox";
import { getAccessToken } from "@/lib/auth";

const store = new Map<string, Record<string, unknown>>();

jest.mock("@/lib/indexeddb", () => ({
  getAllCases: jest.fn(async () => [...store.values()].map((r) => ({ ...r }))),
  updateDraft: jest.fn(async (id: string, fields: Record<string, unknown>) => {
    const existing = store.get(id) ?? { offline_id: id };
    store.set(id, {
      ...existing,
      ...fields,
      offline_id: id,
      sync_status: fields.sync_status ?? existing.sync_status ?? "draft",
    });
  }),
  putCase: jest.fn(),
}));
jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;

function jwt(appMetadata: Record<string, unknown> = {}): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "citizen-1", app_metadata: appMetadata })}.sig`;
}

function seedPoC(id: string, extra: Record<string, unknown> = {}) {
  store.set(id, {
    offline_id: id,
    timestamp_local: "2026-09-17T08:00:00.000Z",
    gps: { lat: 8.3, lng: 80.4 },
    damage_category: "crop",
    submitter_identity_hash: `hash-${id}`,
    sync_status: "pending",
    ...extra,
  });
}

function reply(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
}

const fetchMock = jest.fn();

beforeEach(async () => {
  store.clear();
  __resetCitizenOutboxForTests();
  mockToken.mockReset().mockResolvedValue(jwt());
  fetchMock.mockReset();
  global.fetch = fetchMock;
  setOnline(true);
});

async function queued(id: string, extra: Record<string, unknown> = {}) {
  seedPoC(id, extra);
  await markCitizenSubmission(id, "ta");
}

it("does nothing while offline — the report stays queued with its receipt", async () => {
  await queued("a");
  setOnline(false);
  const result = await flushCitizenOutbox();
  expect(result.skipped).toBe("offline");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await getPendingCitizenSubmissions()).toHaveLength(1);
});

it("delivers a queued report through the citizen endpoint when back online", async () => {
  await queued("a");
  fetchMock.mockResolvedValue(reply(201, { canonical_id: "HEC-2026-0100", offline_id: "a" }));
  const events: unknown[] = [];
  window.addEventListener("hec-case-synced", (e) => events.push((e as CustomEvent).detail));

  const result = await flushCitizenOutbox();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/api\/v1\/cases\/submit$/);
  expect(url).not.toMatch(/sync\/batch/);
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ offline_id: "a", damage_category: "crop", locale: "ta" });
  // Never marked as officer-assisted.
  expect(body.submitted_by_officer).toBeUndefined();
  expect(result.synced).toEqual([{ offline_id: "a", canonical_id: "HEC-2026-0100" }]);
  expect(store.get("a")).toMatchObject({ canonical_id: "HEC-2026-0100", sync_status: "synced" });
  expect(events).toContainEqual({ offline_id: "a", canonical_id: "HEC-2026-0100" });
});

it("is delivered exactly once: a synced report is never sent again", async () => {
  await queued("a");
  fetchMock.mockResolvedValue(reply(201, { canonical_id: "HEC-2026-0100", offline_id: "a" }));
  await flushCitizenOutbox();
  await flushCitizenOutbox();
  await flushCitizenOutbox();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("overlapping triggers (online event + interval) post a report only once", async () => {
  await queued("a");
  let release!: () => void;
  fetchMock.mockReturnValue(
    new Promise((resolve) => {
      release = () => resolve(reply(201, { canonical_id: "HEC-2026-0100", offline_id: "a" }));
    }),
  );
  const first = flushCitizenOutbox();
  const second = await flushCitizenOutbox();
  expect(second.skipped).toBe("in-flight");
  await new Promise((r) => setTimeout(r, 0));
  release();
  await first;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("a retry the server recognises (200, same canonical id) completes without a duplicate", async () => {
  await queued("a");
  fetchMock.mockResolvedValue(reply(200, { canonical_id: "HEC-2026-0100", offline_id: "a" }));
  await flushCitizenOutbox();
  expect(store.get("a")).toMatchObject({ canonical_id: "HEC-2026-0100", sync_status: "synced" });
});

it("a network failure is retried later with backoff, not immediately", async () => {
  await queued("a");
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const t0 = 1_000_000;
  await flushCitizenOutbox(t0);
  expect(store.get("a")).toMatchObject({ sync_status: "pending", citizen_sync_attempts: 1 });

  await flushCitizenOutbox(t0 + 1_000); // not yet due
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fetchMock.mockResolvedValue(reply(201, { canonical_id: "HEC-2026-0101", offline_id: "a" }));
  await flushCitizenOutbox(t0 + 31_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(store.get("a")).toMatchObject({ sync_status: "synced", canonical_id: "HEC-2026-0101" });
});

it("a server error keeps the report pending", async () => {
  await queued("a");
  fetchMock.mockResolvedValue(reply(500, { error: "server_error" }));
  await flushCitizenOutbox();
  expect(store.get("a")).toMatchObject({ sync_status: "pending", citizen_sync_error: "server_error" });
});

it("an expired session stops the run and keeps every report pending", async () => {
  await queued("a");
  await queued("b");
  fetchMock.mockResolvedValue(reply(401, { error: "unauthorized" }));
  await flushCitizenOutbox();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(store.get("a")?.sync_status).toBe("pending");
  expect(store.get("b")?.sync_status).toBe("pending");
});

it("an unregistered household is surfaced as failed rather than retried forever", async () => {
  await queued("a");
  fetchMock.mockResolvedValue(reply(403, { error: "not_registered" }));
  const result = await flushCitizenOutbox();
  expect(result.failed).toEqual([{ offline_id: "a", error: "not_registered" }]);
  expect(store.get("a")).toMatchObject({ sync_status: "failed", citizen_sync_error: "not_registered" });
});

it("waits for a sign-in rather than sending without a session", async () => {
  await queued("a");
  mockToken.mockResolvedValue(null);
  const result = await flushCitizenOutbox();
  expect(result.skipped).toBe("no-session");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("never replays a citizen's report under a staff session on the same browser", async () => {
  await queued("a");
  mockToken.mockResolvedValue(jwt({ role: "officer", assigned_divisions: ["x"] }));
  const result = await flushCitizenOutbox();
  expect(result.skipped).toBe("staff-session");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("ignores officer drafts, unmarked drafts and incomplete receipts", async () => {
  seedPoC("officer", { submission_channel: "citizen", submitted_by_officer: true });
  seedPoC("unmarked");
  store.set("incomplete", { offline_id: "incomplete", sync_status: "pending", submission_channel: "citizen" });
  expect(await getPendingCitizenSubmissions()).toEqual([]);
});
