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
    const url = buildExportUrl("csv", FILTERS);
    expect(url).not.toContain("page=");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("sort=");
    expect(url).not.toContain("dir=");
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
  }) {
    const headers = new Headers();
    if (init.disposition) headers.set("Content-Disposition", init.disposition);
    global.fetch = jest.fn().mockResolvedValue({
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers,
      blob: async () => new Blob([init.body ?? "canonical_id\n"]),
    }) as unknown as typeof fetch;
  }

  it("sends the bearer token", async () => {
    mockFetch({});
    await downloadExport("tok-123", "csv", FILTERS);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/admin/export"),
      { headers: { Authorization: "Bearer tok-123" } },
    );
  });

  it("saves the file and revokes the object URL", async () => {
    mockFetch({ disposition: "attachment; filename=hec-cases-2026-08-06.csv" });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toBe("ok");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:hec");
  });

  it("leaves no anchor behind in the document", async () => {
    mockFetch({});
    await downloadExport("tok", "csv", FILTERS);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it.each([401, 403])("maps %i to unauthorized", async (status) => {
    mockFetch({ status });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toBe("unauthorized");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("maps a server error to error", async () => {
    mockFetch({ status: 500 });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toBe("error");
  });

  it("maps a network failure to error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch;
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toBe("error");
  });

  it("still revokes the object URL when the download throws mid-flight", async () => {
    mockFetch({});
    clickSpy.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(downloadExport("tok", "csv", FILTERS)).resolves.toBe("error");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:hec");
  });
});
