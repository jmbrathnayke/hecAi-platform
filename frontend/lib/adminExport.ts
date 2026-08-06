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
export type ExportResult = "ok" | "unauthorized" | "error";

const FALLBACK_FILENAME: Record<ExportFormat, string> = {
  csv: "hec-cases.csv",
  pdf: "hec-cases.pdf",
};

// Content-Disposition is set by the backend as `attachment; filename=hec-cases-YYYY-MM-DD.ext`.
// Parsed defensively — a proxy that strips or rewrites the header must not break the download.
export function filenameFromDisposition(
  disposition: string | null,
  format: ExportFormat,
): string {
  if (!disposition) return FALLBACK_FILENAME[format];
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match?.[1]?.trim();
  return name ? decodeURIComponent(name) : FALLBACK_FILENAME[format];
}

export function buildExportUrl(format: ExportFormat, filters: AdminCaseFilters): string {
  const qs = new URLSearchParams();
  qs.set("format", format);
  for (const [key, value] of Object.entries(filters)) {
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
  try {
    const res = await fetch(buildExportUrl(format, filters), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    if (!res.ok) return "error";

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
    return "ok";
  } catch {
    return "error";
  } finally {
    // Revoked in `finally` so a throw between createObjectURL and the click can't leak the
    // blob for the lifetime of the document.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
