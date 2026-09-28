/**
 * The citizen photo outbox — delivering a family's damage photographs to a case that has synced.
 *
 * What these pin down is the behaviour that makes an offline queue safe rather than merely
 * present: it never attaches to a case that does not exist yet, it resumes per photograph rather
 * than re-sending the set, it gives up on a photograph the server will never accept, and it never
 * runs under a staff session (which would have the server label a family's photographs as the
 * officer's verification of them).
 */
import {
  flushCitizenPhotos,
  pendingPhotoRecords,
  __resetCitizenPhotoOutboxForTests,
} from "@/lib/citizenPhotoOutbox";
import { getAccessToken } from "@/lib/auth";
import { getAllCases, listPhotoBlobs, updateDraft } from "@/lib/indexeddb";
import { uploadCasePhoto } from "@/lib/casePhotos";
import { staffRoleFromToken } from "@/lib/jwtClaims";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/indexeddb", () => ({
  getAllCases: jest.fn(),
  listPhotoBlobs: jest.fn(),
  updateDraft: jest.fn(),
}));
jest.mock("@/lib/casePhotos", () => ({
  uploadCasePhoto: jest.fn(),
  // The real predicate: only transport and server faults are worth retrying.
  isRetryable: (f: { reason: string }) =>
    ["network", "server", "no-session", "storage-not-configured"].includes(f.reason),
}));
jest.mock("@/lib/jwtClaims", () => ({ staffRoleFromToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const mockAllCases = getAllCases as jest.Mock;
const mockBlobs = listPhotoBlobs as jest.Mock;
const mockUpdate = updateDraft as jest.Mock;
const mockUpload = uploadCasePhoto as jest.Mock;
const mockStaffRole = staffRoleFromToken as jest.Mock;

function record(overrides: Record<string, unknown> = {}) {
  return {
    submission_channel: "citizen",
    offline_id: "off-1",
    canonical_id: "HEC-2026-0295",
    photo_blob_keys: ["k1", "k2"],
    ...overrides,
  };
}

function blobsFor(keys: string[]) {
  return keys.map((k) => ({ blob_key: k, blob: new Blob([k], { type: "image/jpeg" }) }));
}

beforeEach(() => {
  __resetCitizenPhotoOutboxForTests();
  mockToken.mockReset().mockResolvedValue("tok");
  mockStaffRole.mockReset().mockReturnValue(null);
  mockAllCases.mockReset().mockResolvedValue([record()]);
  mockBlobs.mockReset().mockImplementation(async (keys: string[]) => blobsFor(keys));
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockUpload.mockReset().mockResolvedValue({ ok: true, photoId: 1, duplicate: false });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("pendingPhotoRecords", () => {
  it("waits for the case to exist before attaching anything to it", () => {
    // There is nothing to attach to until POST /cases/submit has returned a canonical id.
    expect(pendingPhotoRecords([record({ canonical_id: undefined })])).toEqual([]);
  });

  it("ignores a record whose photographs are all delivered", () => {
    expect(pendingPhotoRecords([record({ photos_uploaded_keys: ["k1", "k2"] })])).toEqual([]);
  });

  it("ignores photographs already given up on, without giving up on the rest", () => {
    expect(pendingPhotoRecords([record({ photos_rejected_keys: ["k1"] })])).toHaveLength(1);
    expect(pendingPhotoRecords([record({ photos_rejected_keys: ["k1", "k2"] })])).toEqual([]);
  });

  it("ignores officer-assisted submissions and anything that is not a citizen report", () => {
    expect(pendingPhotoRecords([record({ submitted_by_officer: true })])).toEqual([]);
    expect(pendingPhotoRecords([record({ submission_channel: "officer" })])).toEqual([]);
  });

  it("ignores a case with no photographs", () => {
    expect(pendingPhotoRecords([record({ photo_blob_keys: [] })])).toEqual([]);
  });
});

describe("flushCitizenPhotos", () => {
  it("uploads each outstanding photograph against the case's canonical id", async () => {
    const res = await flushCitizenPhotos();
    expect(res).toMatchObject({ attempted: 2, uploaded: 2, rejected: 0 });
    expect(mockUpload.mock.calls.map((c) => c[0])).toEqual(["HEC-2026-0295", "HEC-2026-0295"]);
    expect(mockUpdate).toHaveBeenCalledWith("off-1", expect.objectContaining({
      photos_uploaded_keys: ["k1", "k2"],
      photos_next_attempt_at: null,
    }));
  });

  it("resumes at the photograph it stopped on, not at the first", async () => {
    // A flush interrupted after three of ten must not re-send the three.
    mockAllCases.mockResolvedValue([record({ photos_uploaded_keys: ["k1"] })]);
    await flushCitizenPhotos();
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockBlobs).toHaveBeenCalledWith(["k2"]);
  });

  it("stops the record on a retryable failure and schedules a backoff", async () => {
    // The next photograph would fail the same way; hammering the server helps nobody.
    mockUpload.mockResolvedValue({ ok: false, failure: { reason: "network" } });
    const res = await flushCitizenPhotos(1_000);
    expect(res).toMatchObject({ attempted: 1, uploaded: 0 });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const fields = mockUpdate.mock.calls[0][1];
    expect(fields.photos_next_attempt_at).toBeGreaterThan(1_000);
    expect(fields.photos_upload_error).toBe("network");
  });

  it("gives up on a photograph the server will never accept, and carries on", async () => {
    // Too large / wrong type is identical next time. Retrying it would block every photograph
    // behind it forever.
    mockUpload
      .mockResolvedValueOnce({ ok: false, failure: { reason: "too-large" } })
      .mockResolvedValueOnce({ ok: true, photoId: 2, duplicate: false });
    const res = await flushCitizenPhotos();
    expect(res).toMatchObject({ attempted: 2, uploaded: 1, rejected: 1 });
    expect(mockUpdate).toHaveBeenCalledWith("off-1", expect.objectContaining({
      photos_rejected_keys: ["k1"],
      photos_uploaded_keys: ["k2"],
    }));
  });

  it("stops asking for a blob this browser no longer holds", async () => {
    // Storage evicted, or the profile was cleared. Retrying cannot bring it back.
    mockBlobs.mockResolvedValue(blobsFor(["k2"]));
    const res = await flushCitizenPhotos();
    expect(res).toMatchObject({ rejected: 1, uploaded: 1 });
    expect(mockUpdate).toHaveBeenCalledWith("off-1", expect.objectContaining({
      photos_rejected_keys: ["k1"],
    }));
  });

  it("does nothing offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    expect(await flushCitizenPhotos()).toMatchObject({ skipped: "offline" });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("does nothing under a staff session", async () => {
    // The server derives `source` from the token: a staff session would have a family's own
    // photographs stored as the officer's verification of them.
    mockStaffRole.mockReturnValue("officer");
    expect(await flushCitizenPhotos()).toMatchObject({ skipped: "staff-session" });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("does nothing without a session", async () => {
    mockToken.mockResolvedValue(null);
    expect(await flushCitizenPhotos()).toMatchObject({ skipped: "no-session" });
  });

  it("waits out a scheduled backoff", async () => {
    mockAllCases.mockResolvedValue([record({ photos_next_attempt_at: 10_000 })]);
    expect(await flushCitizenPhotos(5_000)).toMatchObject({ attempted: 0 });
    expect(mockUpload).not.toHaveBeenCalled();
    expect((await flushCitizenPhotos(10_001)).attempted).toBe(2);
  });

  it("never runs two flushes at once", async () => {
    // Two triggers fire together (the `online` event and the interval). Without the guard both
    // would upload the same photographs, and the server would absorb the duplicates -- but only
    // after the citizen's connection had carried each image twice.
    // Held at the very first await, so the second call is guaranteed to arrive mid-flush.
    let release: () => void = () => {};
    mockAllCases.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve([record()]); }),
    );

    const first = flushCitizenPhotos();
    await Promise.resolve();
    expect(await flushCitizenPhotos()).toMatchObject({ skipped: "in-flight" });

    release();
    await first;
    expect(mockUpload).toHaveBeenCalledTimes(2); // the held flush, once released, did the work
  });
});
