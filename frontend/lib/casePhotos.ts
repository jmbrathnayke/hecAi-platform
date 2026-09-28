// Case evidence photographs (backend migration 038, app/api/v1/case_photos.py).
//
// WHAT THIS CLOSES. Until now no image reached the server on any path. A citizen captured 1–10
// damage photos into this browser's IndexedDB and an officer captured a verification photo, and
// both stayed on the device — so an administrator approved, and a Divisional Secretariat paid, on
// a class label and a percentage alone. Nobody downstream of the field officer could see what had
// been photographed, which meant a decision could not be shown and an appeal could not be examined.
//
// WHAT IT DOES NOT CHANGE. MobileNetV2 still runs entirely on the device (FR-2.1/2.2). No image is
// sent anywhere to be classified; nothing here is a model input. Storing evidence and classifying
// on-device are independent, and only the first is new.
//
// THE SERVER DECIDES EVERYTHING THAT MATTERS. Scope (whose cases this caller may see) and the
// `source` label (`citizen` vs `officer`) are both derived from the verified JWT — this module
// never sends either. A client that could name its own source could forge the officer's
// corroboration of a claimant's photograph.
//
// Failures are a discriminated union, same discipline as lib/dsCases.ts: "you are signed out",
// "this deployment has no object store" and "the network dropped" need different screens.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface CasePhoto {
  id: number;
  /** Who took it. `officer` is the image MobileNetV2 classified, so it is what the assessment
   *  rests on; `citizen` is the household's own account of the damage. */
  source: "citizen" | "officer";
  content_type: string;
  byte_size: number;
  created_at: string | null;
  /** Short-lived signed URL, or null when the stored object could not be signed. Null renders as
   *  an unavailable tile rather than being dropped, so a missing object is visible instead of
   *  looking like a case that never had photographs. */
  url: string | null;
}

export type PhotoFailure =
  | { reason: "no-session" }
  | { reason: "signed-out" }
  | { reason: "not-found" }
  | { reason: "forbidden" }
  | { reason: "storage-not-configured" }
  | { reason: "too-large" }
  | { reason: "unsupported-type" }
  | { reason: "too-many" }
  | { reason: "network" }
  | { reason: "server" };

export type PhotoListResult =
  | { ok: true; photos: CasePhoto[] }
  | { ok: false; failure: PhotoFailure };

export type PhotoUploadResult =
  | { ok: true; photoId: number | null; duplicate: boolean }
  | { ok: false; failure: PhotoFailure };

function classify(status: number, code: string): PhotoFailure {
  if (status === 401) return { reason: "signed-out" };
  if (status === 403) return { reason: "forbidden" };
  if (status === 404) return { reason: "not-found" };
  if (status === 413) return { reason: "too-large" };
  if (status === 415) return { reason: "unsupported-type" };
  if (status === 409) return { reason: "too-many" };
  if (code === "storage_not_configured") return { reason: "storage-not-configured" };
  return { reason: "server" };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}

/** The case's photographs, both sources, oldest first. `ref` is a canonical id or an offline id. */
export async function listCasePhotos(ref: string): Promise<PhotoListResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/cases/${encodeURIComponent(ref)}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) return { ok: false, failure: classify(res.status, await readError(res)) };

  try {
    const body = (await res.json()) as { photos?: unknown };
    return { ok: true, photos: Array.isArray(body.photos) ? (body.photos as CasePhoto[]) : [] };
  } catch {
    return { ok: false, failure: { reason: "server" } };
  }
}

/**
 * Upload one image against the case.
 *
 * Sent as multipart/form-data rather than JSON+base64: base64 inflates the body by a third, and on
 * the rural connections this has to work over that is a third more of an upload that may already
 * be retrying.
 */
export async function uploadCasePhoto(ref: string, blob: Blob): Promise<PhotoUploadResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  const form = new FormData();
  // A filename is required by some servers' multipart parsers; the extension is cosmetic, since
  // the server trusts the part's content type and its own whitelist, never this name.
  form.append("photo", blob, "photo.jpg");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/cases/${encodeURIComponent(ref)}/photos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (!res.ok) return { ok: false, failure: classify(res.status, await readError(res)) };

  try {
    const body = (await res.json()) as { photo_id?: number; duplicate?: boolean };
    return {
      ok: true,
      photoId: typeof body.photo_id === "number" ? body.photo_id : null,
      duplicate: body.duplicate === true,
    };
  } catch {
    // A 2xx with an unreadable body still means the server stored it. Reporting failure here
    // would make the caller retry an upload that already succeeded.
    return { ok: true, photoId: null, duplicate: false };
  }
}

/**
 * Whether a failed upload is worth trying again.
 *
 * A rejection about the FILE — too large, wrong type, the case is full — will be rejected
 * identically forever, so an offline queue that retried it would spin until the record was
 * manually cleared. Only transport and server-side faults are retryable.
 */
export function isRetryable(failure: PhotoFailure): boolean {
  return (
    failure.reason === "network" ||
    failure.reason === "server" ||
    failure.reason === "no-session" ||
    failure.reason === "storage-not-configured"
  );
}
