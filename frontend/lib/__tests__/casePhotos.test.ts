/**
 * The case-photo client.
 *
 * Two things here decide whether the evidence pipeline is safe. The first is that this module
 * never sends a `source` label or a scope — both are derived server-side from the verified JWT,
 * because a client that could name its own source could forge the officer's corroboration of a
 * claimant's photograph. The second is `isRetryable`: an offline queue that retried a rejection
 * about the FILE would spin forever on a photograph that can never be accepted.
 */
import {
  isRetryable,
  listCasePhotos,
  uploadCasePhoto,
  type PhotoFailure,
} from "@/lib/casePhotos";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const fetchMock = jest.fn();

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue("tok");
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

describe("listCasePhotos", () => {
  it("returns both sources as the server ordered them", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        photos: [
          { id: 1, source: "citizen", url: "https://s/1", content_type: "image/jpeg", byte_size: 1, created_at: null },
          { id: 2, source: "officer", url: "https://s/2", content_type: "image/jpeg", byte_size: 2, created_at: null },
        ],
      }),
    );
    const res = await listCasePhotos("HEC-2026-0295");
    expect(res).toEqual({
      ok: true,
      photos: [expect.objectContaining({ source: "citizen" }), expect.objectContaining({ source: "officer" })],
    });
  });

  it("sends the bearer token and nothing about scope", async () => {
    fetchMock.mockResolvedValue(reply(200, { photos: [] }));
    await listCasePhotos("HEC-2026-0295");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/cases\/HEC-2026-0295\/photos$/);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("escapes a reference rather than pasting it into the path", async () => {
    fetchMock.mockResolvedValue(reply(200, { photos: [] }));
    await listCasePhotos("HEC 2026/0295");
    expect(fetchMock.mock.calls[0][0]).toContain("HEC%202026%2F0295");
  });

  it("does not call the network without a session", async () => {
    mockToken.mockResolvedValue(null);
    expect(await listCasePhotos("HEC-2026-0295")).toEqual({
      ok: false,
      failure: { reason: "no-session" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "signed-out"],
    [403, "forbidden"],
    [404, "not-found"],
    [500, "server"],
  ])("maps %i to %s", async (status, reason) => {
    fetchMock.mockResolvedValue(reply(status, { error: "x" }));
    const res = await listCasePhotos("HEC-2026-0295");
    expect(res).toEqual({ ok: false, failure: { reason } });
  });

  it("distinguishes a deployment with no object store from a server fault", async () => {
    // They need different screens: one is a network problem, the other is an operator fact.
    fetchMock.mockResolvedValue(reply(503, { error: "storage_not_configured" }));
    expect(await listCasePhotos("HEC-2026-0295")).toEqual({
      ok: false,
      failure: { reason: "storage-not-configured" },
    });
  });

  it("reports a dropped connection as network, not as a server error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await listCasePhotos("HEC-2026-0295")).toEqual({
      ok: false,
      failure: { reason: "network" },
    });
  });
});

describe("uploadCasePhoto", () => {
  const blob = () => new Blob(["bytes"], { type: "image/jpeg" });

  it("posts the image as multipart under the field the server reads", async () => {
    fetchMock.mockResolvedValue(reply(201, { photo_id: 7 }));
    const res = await uploadCasePhoto("HEC-2026-0295", blob());
    expect(res).toEqual({ ok: true, photoId: 7, duplicate: false });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("photo")).toBeInstanceOf(Blob);
  });

  it("never sends a source label — the server derives it from the token", async () => {
    // This is the forgery the label exists to prevent: a citizen's photograph presented as the
    // officer's verification of it.
    fetchMock.mockResolvedValue(reply(201, { photo_id: 7 }));
    await uploadCasePhoto("HEC-2026-0295", blob());
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect([...form.keys()]).toEqual(["photo"]);
  });

  it("does not set Content-Type itself, so the multipart boundary is not lost", async () => {
    fetchMock.mockResolvedValue(reply(201, { photo_id: 7 }));
    await uploadCasePhoto("HEC-2026-0295", blob());
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();
  });

  it("treats the server's duplicate answer as success", async () => {
    // An offline retry of an upload that already landed. Reporting failure would make the queue
    // send it again, forever.
    fetchMock.mockResolvedValue(reply(200, { duplicate: true }));
    expect(await uploadCasePhoto("HEC-2026-0295", blob())).toEqual({
      ok: true, photoId: null, duplicate: true,
    });
  });

  it("treats a 2xx with an unreadable body as stored", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => { throw new Error("x"); } });
    expect(await uploadCasePhoto("HEC-2026-0295", blob())).toEqual({
      ok: true, photoId: null, duplicate: false,
    });
  });

  it.each([
    [413, "too-large"],
    [415, "unsupported-type"],
    [409, "too-many"],
    [404, "not-found"],
  ])("maps %i to %s", async (status, reason) => {
    fetchMock.mockResolvedValue(reply(status, { error: "x" }));
    expect(await uploadCasePhoto("HEC-2026-0295", blob())).toEqual({ ok: false, failure: { reason } });
  });
});

describe("isRetryable", () => {
  it("retries transport and server faults", () => {
    for (const reason of ["network", "server", "no-session", "storage-not-configured"] as const) {
      expect(isRetryable({ reason } as PhotoFailure)).toBe(true);
    }
  });

  it("never retries a rejection about the file itself", () => {
    // Too large, wrong type, the case is full: identical next time, so a queue that retried would
    // spin until someone cleared the record by hand.
    for (const reason of ["too-large", "unsupported-type", "too-many", "not-found", "forbidden", "signed-out"] as const) {
      expect(isRetryable({ reason } as PhotoFailure)).toBe(false);
    }
  });
});
