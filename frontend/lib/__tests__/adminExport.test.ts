import {
  buildExportUrl,
  downloadExport,
  filenameFromDisposition,
} from "@/lib/adminExport";
import { EMPTY_FILTERS } from "@/components/admin/FilterBar";

const FILTERS = { ...EMPTY_FILTERS, status: "Approved", type: "crop" };

describe("buildExportUrl", () => {
  it("always carries the format", () => {
    expect(buildExportUrl("pdf", EMPTY_FILTERS)).toContain("format=pdf");
  });

  it("forwards populated filters", () => {
    const url = buildExportUrl("csv", FILTERS);
    expect(url).toContain("status=Approved");
    expect(url).toContain("type=crop");
  });

  it("omits empty filters entirely", () => {
    // Mirrors fetchAdminCases's own serialisation: an empty string is "not filtered", and
    // sending `status=` would make the backend's `if status_filter:` guard the only thing
    // standing between the export and a zero-row result.
    const url = buildExportUrl("csv", EMPTY_FILTERS);
    expect(url).not.toContain("status=");
    expect(url).not.toContain("from=");
    expect(url).not.toContain("division=");
  });

  it("never forwards pagination or sort parameters", () => {
    // AC1: the export is the whole filtered set, not the current page.
    //
    // Code review finding: the first version of this test passed FILTERS (spread from
    // EMPTY_FILTERS, which has no pagination keys), so the assertions were vacuously true no
    // matter what the implementation did — a blind Object.entries() pass-through satisfied it
    // just as well as a whitelist. Extra keys are injected deliberately here so the test can
    // actually fail if the serialiser ever stops filtering.
    const polluted = {
      ...FILTERS,
      page: 3,
      limit: 20,
      sort: "submitted_at",
      dir: "desc",
      district: "SOMEWHERE-ELSE",
    } as unknown as typeof FILTERS;

    const url = buildExportUrl("csv", polluted);
    expect(url).not.toContain("page=");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("sort=");
    expect(url).not.toContain("dir=");
    // district must never be forwarded either — scope comes from the verified JWT (AC4).
    expect(url).not.toContain("district=");
    // …while the real filters still survive.
    expect(url).toContain("status=Approved");
  });

  it("percent-encodes Sinhala division names", () => {
    const url = buildExportUrl("csv", { ...EMPTY_FILTERS, division: "ඉපලෝගම" });
    expect(url).toContain("division=%E0%B6%89");
  });
});

describe("filenameFromDisposition", () => {
  it("reads the backend's filename", () => {
    expect(
      filenameFromDisposition("attachment; filename=hec-cases-2026-08-06.csv", "csv"),
    ).toBe("hec-cases-2026-08-06.csv");
  });

  it("handles a quoted filename", () => {
    expect(
      filenameFromDisposition('attachment; filename="hec-cases-2026-08-06.pdf"', "pdf"),
    ).toBe("hec-cases-2026-08-06.pdf");
  });

  it("falls back when the header is missing", () => {
    expect(filenameFromDisposition(null, "csv")).toBe("hec-cases.csv");
    expect(filenameFromDisposition(null, "pdf")).toBe("hec-cases.pdf");
  });

  it("falls back when the header carries no filename", () => {
    expect(filenameFromDisposition("attachment", "csv")).toBe("hec-cases.csv");
  });

  it("does not throw on a malformed percent-escape", () => {
    // Code review finding: decodeURIComponent raises URIError on a bare `%`. This function is
    // the designated defence against a proxy rewriting the header, so throwing here was
    // precisely the wrong failure — it propagated into downloadExport's catch and reported
    // "Export failed" for a download that had already arrived intact.
    expect(() =>
      filenameFromDisposition("attachment; filename=hec-100%-cases.csv", "csv"),
    ).not.toThrow();
    expect(
      filenameFromDisposition("attachment; filename=hec-100%-cases.csv", "csv"),
    ).toBe("hec-100%-cases.csv");
  });

  it("still decodes a correctly-encoded filename", () => {
    expect(
      filenameFromDisposition("attachment; filename=hec%20cases.csv", "csv"),
    ).toBe("hec cases.csv");
  });
});

describe("downloadExport", () => {
  const createObjectURL = jest.fn(() => "blob:hec");
  const revokeObjectURL = jest.fn();
  let clickSpy: jest.SpyInstance;

  beforeAll(() => {
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true });
  });

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
    // @ts-expect-error test cleanup
    delete global.fetch;
  });

  function mockFetch(init: {
    status?: number;
    disposition?: string | null;
    body?: string;
    truncated?: boolean;
    rowCount?: number;
  }) {
    const headers = new Headers();
    if (init.disposition) headers.set("Content-Disposition", init.disposition);
    if (init.truncated !== undefined) {
      headers.set("X-HEC-Truncated", String(init.truncated));
    }
    if (init.rowCount !== undefined) {
      headers.set("X-HEC-Row-Count", String(init.rowCount));
    }
    global.fetch = jest.fn().mockResolvedValue({
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers,
      blob: async () => new Blob([init.body ?? "canonical_id\n"]),
    }) as unknown as typeof fetch;
  }

  // The object URL is now revoked in a deferred macrotask (a synchronous revoke races the
  // browser's read of the blob and produces zero-byte downloads in Firefox/Safari), so tests
  // must let the timer queue drain before asserting on it.
  const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("sends the bearer token", async () => {
    mockFetch({});
    await downloadExport("tok-123", "csv", FILTERS);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/admin/export"),
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-123" },
        signal: expect.anything(),
      }),
    );
  });

  it("saves the file and revokes the object URL", async () => {
    mockFetch({ disposition: "attachment; filename=hec-cases-2026-08-06.csv" });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({ status: "ok" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    await flushTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:hec");
  });

  it("does not revoke the object URL in the same tick as the click", async () => {
    mockFetch({});
    await downloadExport("tok", "csv", FILTERS);
    // Still pending immediately after the call resolves…
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await flushTimers();
    // …but released once the macrotask queue drains, so nothing leaks.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:hec");
  });

  it("reports truncation from the response headers", async () => {
    mockFetch({ truncated: true, rowCount: 2000 });
    await expect(downloadExport("tok", "pdf", FILTERS)).resolves.toMatchObject({
      status: "ok",
      truncated: true,
      rowCount: 2000,
    });
  });

  it("reports a complete export as not truncated", async () => {
    mockFetch({ truncated: false, rowCount: 12 });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({
      status: "ok",
      truncated: false,
    });
  });

  it("tolerates the truncation headers being absent (CORS-stripped or older backend)", async () => {
    mockFetch({});
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({
      status: "ok",
      truncated: false,
      rowCount: undefined,
    });
  });

  it("maps an aborted request to timeout", async () => {
    global.fetch = jest.fn().mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    ) as unknown as typeof fetch;
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({
      status: "timeout",
    });
  });

  it("leaves no anchor behind in the document", async () => {
    mockFetch({});
    await downloadExport("tok", "csv", FILTERS);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it.each([401, 403])("maps %i to unauthorized", async (status) => {
    mockFetch({ status });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({ status: "unauthorized" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("maps a server error to error", async () => {
    mockFetch({ status: 500 });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({ status: "error" });
  });

  it("maps a network failure to error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch;
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({ status: "error" });
  });

  it("still revokes the object URL when the download throws mid-flight", async () => {
    mockFetch({});
    clickSpy.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toMatchObject({ status: "error" });
    await flushTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:hec");
  });
});
