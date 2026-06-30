import { computeIdentityHash, toPoCRecord, submitCaseOnline, PoCRecord } from "@/lib/poc";

describe("computeIdentityHash", () => {
  it("is deterministic for the same inputs", async () => {
    const a = await computeIdentityHash("id-1", "cipher");
    const b = await computeIdentityHash("id-1", "cipher");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("differs when the offline_id or ciphertext differs", async () => {
    const base = await computeIdentityHash("id-1", "cipher");
    expect(await computeIdentityHash("id-2", "cipher")).not.toBe(base);
    expect(await computeIdentityHash("id-1", "other")).not.toBe(base);
  });
});

describe("toPoCRecord", () => {
  it("maps location_lat/lng to gps and carries category + pending status", () => {
    const rec = toPoCRecord(
      { location_lat: 7.29, location_lng: 80.63, damage_category: "crop" },
      "off-1",
      "2026-06-30T00:00:00.000Z",
      "hash",
    );
    expect(rec).toEqual({
      offline_id: "off-1",
      timestamp_local: "2026-06-30T00:00:00.000Z",
      gps: { lat: 7.29, lng: 80.63 },
      damage_category: "crop",
      submitter_identity_hash: "hash",
      sync_status: "pending",
    });
  });

  it("yields gps=null when coordinates are missing/invalid", () => {
    const rec = toPoCRecord({ damage_category: "property" }, "off-2", "ts", "h");
    expect(rec.gps).toBeNull();
    expect(rec.damage_category).toBe("property");
  });

  it("preserves a synced status", () => {
    const rec = toPoCRecord({ sync_status: "synced" }, "off-3", "ts", "h");
    expect(rec.sync_status).toBe("synced");
    expect(rec.damage_category).toBeNull();
  });
});

describe("submitCaseOnline", () => {
  const record: PoCRecord = {
    offline_id: "off-9",
    timestamp_local: "2026-06-30T00:00:00.000Z",
    gps: { lat: 1, lng: 2 },
    damage_category: "crop",
    submitter_identity_hash: "h",
    sync_status: "pending",
  };
  afterEach(() => {
    (global.fetch as jest.Mock | undefined)?.mockReset?.();
  });

  it("posts with the bearer token and returns canonical_id on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ canonical_id: "HEC-2026-0001", offline_id: "off-9" }),
    }) as unknown as typeof fetch;

    const res = await submitCaseOnline(record, "tok-123");
    expect(res).toEqual({ canonical_id: "HEC-2026-0001", offline_id: "off-9" });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/api/v1/cases/submit");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body).offline_id).toBe("off-9");
    expect(JSON.parse(init.body).gps).toEqual({ lat: 1, lng: 2 });
  });

  it("returns null on a non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await submitCaseOnline(record, "t")).toBeNull();
  });

  it("returns null when the network throws", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    expect(await submitCaseOnline(record, "t")).toBeNull();
  });

  it("returns null when the response is missing fields", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ offline_id: "off-9" }) }) as unknown as typeof fetch;
    expect(await submitCaseOnline(record, "t")).toBeNull();
  });
});
