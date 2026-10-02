// Delivers a citizen's damage photographs to the case they belong to, after the case itself has
// synced (backend migration 038).
//
// WHY THIS IS A SECOND PASS AND NOT PART OF THE SUBMISSION. A photograph can only be attached to a
// case that exists, and the case is created by POST /cases/submit -- so the upload cannot ride
// along with it. It is also much the larger transfer: on the rural connections this has to work
// over, a report that waited for ten images to upload before it counted as filed would leave the
// citizen holding a receipt for nothing. The report lands first and counts; the photographs follow.
//
// WHY A SEPARATE MODULE FROM citizenOutbox.ts. That one has exactly one job -- get the report to
// the server -- and its correctness argument (offline_id is UNIQUE, a retry returns the same
// canonical id) is about that endpoint. This is a different endpoint with a different idempotency
// story (the server deduplicates by SHA-256 per case), a different failure taxonomy, and per-photo
// rather than per-record progress. Folding them together would blur both.
//
// PROGRESS IS PER PHOTO. `photos_uploaded_keys` records which blobs the server has confirmed, so a
// flush interrupted after three of ten resumes at the fourth rather than re-sending all ten. Blobs
// are NOT deleted afterwards: they are the family's own copy, backing the Proof of Claim on their
// phone, and removing them is not this queue's decision to make.
import { getAccessToken } from "@/lib/auth";
import { isRetryable, uploadCasePhoto, type PhotoFailure } from "@/lib/casePhotos";
import { getAllCases, listPhotoBlobs, updateDraft } from "@/lib/indexeddb";
import { staffRoleFromToken } from "@/lib/jwtClaims";
import { CITIZEN_CHANNEL, type OutboxRecord } from "@/lib/citizenOutbox";

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface PhotoFlushResult {
  attempted: number;
  uploaded: number;
  /** Photos that will never succeed and are no longer retried (too large, wrong type, case full). */
  rejected: number;
  skipped?: "offline" | "in-flight" | "no-session" | "staff-session";
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Records with photographs still to deliver: a citizen submission the server has acknowledged
 * (it has a canonical id), holding blob keys that are neither confirmed uploaded nor permanently
 * rejected.
 */
export function pendingPhotoRecords(all: OutboxRecord[]): OutboxRecord[] {
  return all.filter((r) => {
    if (r.submission_channel !== CITIZEN_CHANNEL) return false;
    if (r.submitted_by_officer === true) return false;
    if (typeof r.offline_id !== "string") return false;
    // Before the case exists there is nothing to attach to.
    if (typeof r.canonical_id !== "string" || !r.canonical_id) return false;
    const keys = stringList(r.photo_blob_keys);
    if (keys.length === 0) return false;
    const done = new Set([...stringList(r.photos_uploaded_keys), ...stringList(r.photos_rejected_keys)]);
    return keys.some((k) => !done.has(k));
  });
}

/** How far one report's photographs have got. Read from this phone's own outbox record. */
export interface PhotoDelivery {
  total: number;
  /** Confirmed stored on the server, where the officer, administrator and DS can see them. */
  uploaded: number;
  /** Will never upload (too large, wrong type, the blob is gone from this phone). */
  rejected: number;
  /** Still on this phone, waiting to be sent. */
  pending: number;
}

export function photoDelivery(record: OutboxRecord): PhotoDelivery {
  const keys = stringList(record.photo_blob_keys);
  const uploaded = new Set(stringList(record.photos_uploaded_keys));
  const rejected = new Set(stringList(record.photos_rejected_keys));
  const up = keys.filter((k) => uploaded.has(k)).length;
  const rej = keys.filter((k) => !uploaded.has(k) && rejected.has(k)).length;
  return { total: keys.length, uploaded: up, rejected: rej, pending: keys.length - up - rej };
}

let inFlight = false;

/**
 * Upload every citizen photograph that is due. Safe to call from any trigger, as often as wanted:
 * a no-op offline, while another flush runs, with no session, or with a staff session signed in.
 *
 * `force` is for a citizen pressing "Send now": it ignores the retry backoff for this attempt only.
 * It is a separate flag rather than a far-future `now`, because `now` also stamps the next retry
 * time, and a failure under a fake clock would schedule that retry years away.
 */
export async function flushCitizenPhotos(
  now: number = Date.now(),
  { force = false }: { force?: boolean } = {},
): Promise<PhotoFlushResult> {
  const result: PhotoFlushResult = { attempted: 0, uploaded: 0, rejected: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ...result, skipped: "offline" };
  }
  if (inFlight) return { ...result, skipped: "in-flight" };
  inFlight = true;
  try {
    const due = pendingPhotoRecords(await getAllCases()).filter((r) => {
      if (force) return true;
      const next = r.photos_next_attempt_at;
      return typeof next !== "number" || next <= now;
    });
    if (due.length === 0) return result;

    const token = await getAccessToken();
    if (!token) return { ...result, skipped: "no-session" };
    // A staff account signed in on the same browser must not attach a family's photographs under
    // its own identity -- the server would label them `officer`, which is exactly the forgery the
    // source label exists to prevent.
    if (staffRoleFromToken(token)) return { ...result, skipped: "staff-session" };

    for (const record of due) {
      const offlineId = record.offline_id as string;
      const ref = record.canonical_id as string;
      const keys = stringList(record.photo_blob_keys);
      const uploaded = new Set(stringList(record.photos_uploaded_keys));
      const rejected = new Set(stringList(record.photos_rejected_keys));
      const outstanding = keys.filter((k) => !uploaded.has(k) && !rejected.has(k));

      const blobs = new Map(
        (await listPhotoBlobs(outstanding)).map((b) => [b.blob_key, b.blob] as const),
      );

      let retryLater: PhotoFailure | null = null;
      for (const key of outstanding) {
        const blob = blobs.get(key);
        if (!blob) {
          // The draft references a blob this browser no longer holds (storage evicted, profile
          // cleared). Retrying cannot conjure it back, so stop asking.
          rejected.add(key);
          result.rejected += 1;
          continue;
        }
        result.attempted += 1;
        const res = await uploadCasePhoto(ref, blob);
        if (res.ok) {
          uploaded.add(key);
          result.uploaded += 1;
          continue;
        }
        if (isRetryable(res.failure)) {
          retryLater = res.failure;
          break; // the next photo would fail the same way; wait out the backoff
        }
        rejected.add(key);
        result.rejected += 1;
      }

      const attempts =
        (typeof record.photos_upload_attempts === "number" ? record.photos_upload_attempts : 0) + 1;
      await updateDraft(offlineId, {
        photos_uploaded_keys: [...uploaded],
        photos_rejected_keys: [...rejected],
        photos_upload_attempts: retryLater ? attempts : 0,
        photos_next_attempt_at: retryLater ? now + backoffMs(attempts) : null,
        photos_upload_error: retryLater ? retryLater.reason : null,
      }).catch(() => {
        /* the upload still happened; the marker is a resume hint, not the record of truth */
      });
    }
    return result;
  } finally {
    inFlight = false;
  }
}

/** Test seam: reset the re-entrancy guard between tests. */
export function __resetCitizenPhotoOutboxForTests(): void {
  inFlight = false;
}
