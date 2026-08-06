// Admin case-export data layer (Story 7.2, FR-7.2). Calls GET /api/v1/admin/export with the
// admin's Supabase JWT and saves the returned file. The backend does all district scoping and
// filtering — this module only shapes the request and drives the download, no business logic.
//
// The request MUST go through fetch() rather than a plain `<a href download>`: the endpoint is
// bearer-authenticated and an anchor cannot carry an Authorization header. That means the body
// is buffered into a Blob client-side; the server-side streaming still bounds the SERVER's
// memory and improves time-to-first-byte, which is the guarantee Story 7.2 AC3 actually makes.
import type { AdminCaseFilters } from "@/components/admin/FilterBar";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export type ExportFormat = "csv" | "pdf";

// Mirrors adminCases.ts's UNAUTHORIZED sentinel: a 401/403 means retrying replays the same
// failing request forever, so the caller should re-authenticate instead of showing "try again".
export type ExportStatus = "ok" | "unauthorized" | "error" | "timeout";

export interface ExportResult {
  status: ExportStatus;
  // Populated from X-HEC-Truncated / X-HEC-Row-Count so the UI can tell the admin their file
  // is a capped subset (code review finding: truncation used to be invisible to the person
  // holding the file). Requires the backend's CORS expose_headers, added in the same review.
  truncated?: boolean;
  rowCount?: number;
}

// An export of the full cap is a large, slow response; without a ceiling a hung request leaves
// the button in its in-flight state forever with no way to retry (code review finding).
const EXPORT_TIMEOUT_MS = 120_000;

const FALLBACK_FILENAME: Record<ExportFormat, string> = {
  csv: "hec-cases.csv",
  pdf: "hec-cases.pdf",
};

// The filter keys this endpoint accepts, enumerated explicitly rather than spreading whatever
// AdminCaseFilters happens to contain (code review finding). AC1 requires the export to cover
// the whole filtered set, never one page — a blind Object.entries() pass-through would silently
// start forwarding `page`/`limit` the day AdminCaseFilters gains such a field, and the test that
// claimed to guard this was vacuous because EMPTY_FILTERS has no such keys to leak.
const EXPORT_FILTER_KEYS = ["status", "from", "to", "type", "division"] as const;

// Content-Disposition is set by the backend as `attachment; filename=hec-cases-YYYY-MM-DD.ext`.
// Parsed defensively — a proxy that strips or rewrites the header must not break the download.
export function filenameFromDisposition(
  disposition: string | null,
  format: ExportFormat,
): string {
  if (!disposition) return FALLBACK_FILENAME[format];
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match?.[1]?.trim();
  if (!name) return FALLBACK_FILENAME[format];
  try {
    return decodeURIComponent(name);
  } catch {
    // decodeURIComponent throws URIError on a bare `%` (e.g. `hec-100%-cases.csv`). This
    // function exists to survive a proxy rewriting the header, so it must not be the thing
    // that fails: previously the throw propagated into downloadExport's catch and turned a
    // perfectly good download into "Export failed" (code review finding).
    return name;
  }
}

export function buildExportUrl(format: ExportFormat, filters: AdminCaseFilters): string {
  const qs = new URLSearchParams();
  qs.set("format", format);
  for (const key of EXPORT_FILTER_KEYS) {
    const value = filters[key];
    if (value !== null && value !== undefined && value !== "") qs.set(key, String(value));
  }
  return `${API_BASE}/api/v1/admin/export?${qs.toString()}`;
}

export async function downloadExport(
  token: string,
  format: ExportFormat,
  filters: AdminCaseFilters,
): Promise<ExportResult> {
  let objectUrl: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);

  try {
    const res = await fetch(buildExportUrl(format, filters), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    if (!res.ok) return { status: "error" };

    const truncated = res.headers.get("X-HEC-Truncated") === "true";
    const rawCount = res.headers.get("X-HEC-Row-Count");
    const rowCount = rawCount === null ? undefined : Number(rawCount);

    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
      format,
    );

    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    return {
      status: "ok",
      truncated,
      rowCount: Number.isFinite(rowCount) ? rowCount : undefined,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "timeout" };
    }
    return { status: "error" };
  } finally {
    clearTimeout(timer);
    if (objectUrl) {
      // Deferred, NOT revoked synchronously here (code review finding): revoking in the same
      // tick as the programmatic click races the browser's read of the blob — Firefox and
      // Safari are documented to produce a cancelled or zero-byte download from exactly that
      // pattern. A macrotask is enough to let the download commit; the URL is still released,
      // just not while it is being read.
      const url = objectUrl;
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}
