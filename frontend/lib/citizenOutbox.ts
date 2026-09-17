// Citizen offline submission outbox (final governance workflow).
//
// THE GAP THIS CLOSES. An officer's report made offline has always synced by itself (the
// sync_queue -> POST /sync/batch, lib/syncQueue.ts). A citizen's did not: the Proof of Claim page
// tried ONE online submission when it rendered, and a citizen who was offline at that moment kept a
// receipt for a case the server never received -- until they happened to reopen that exact page.
//
// WHY NOT THE OFFICER QUEUE. /sync/batch is officer-only (require_officer) and carries officer
// fields; a citizen must not use it. The citizen path already has an idempotent endpoint --
// POST /cases/submit returns the existing canonical id for a known offline_id (200) instead of
// creating a second case -- so the outbox simply retries that endpoint until the server confirms.
//
// WHY THE `cases` STORE AND NOT A NEW ONE. The PoC is already persisted there with
// sync_status "pending" (lib/poc.ts::buildPoC). Adding an object store needs an IndexedDB version
// bump, and this database's upgrade handler recreates sync_queue on upgrade -- which would discard
// every officer report still waiting to sync. The outbox is a marker and a retry schedule on the
// record that already exists.
//
// EXACTLY ONCE. The server is the guarantee (offline_id is UNIQUE; a retry returns the same
// canonical id and does not re-announce the case). The client adds a re-entrancy guard so two
// triggers (the `online` event and the interval) never post the same record concurrently, and
// never posts a record that already carries a canonical id.
import { getAccessToken } from "@/lib/auth";
import { getAllCases, updateDraft } from "@/lib/indexeddb";
import { staffRoleFromToken } from "@/lib/jwtClaims";
import { buildCasePayload, toPoCRecord } from "@/lib/poc";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export const CITIZEN_CHANNEL = "citizen";
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export type OutboxRecord = Record<string, unknown>;

export interface FlushResult {
  attempted: number;
  synced: { offline_id: string; canonical_id: string }[];
  failed: { offline_id: string; error: string }[];
  /** Why nothing was attempted, when nothing was. */
  skipped?: "offline" | "in-flight" | "no-session" | "staff-session";
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/** Mark a built Proof of Claim as a citizen submission the outbox is responsible for delivering. */
export async function markCitizenSubmission(offlineId: string, locale?: string): Promise<void> {
  const fields: Record<string, unknown> = { submission_channel: CITIZEN_CHANNEL };
  if (locale === "si" || locale === "ta" || locale === "en") fields.locale = locale;
  await updateDraft(offlineId, fields);
}

export function isPendingCitizenSubmission(record: OutboxRecord): boolean {
  return (
    record.submission_channel === CITIZEN_CHANNEL &&
    record.sync_status === "pending" &&
    !record.canonical_id &&
    record.submitted_by_officer !== true &&
    typeof record.offline_id === "string" &&
    typeof record.timestamp_local === "string" &&
    typeof record.submitter_identity_hash === "string"
  );
}

export async function getPendingCitizenSubmissions(): Promise<OutboxRecord[]> {
  const all = await getAllCases();
  return all.filter(isPendingCitizenSubmission);
}

function payloadFor(record: OutboxRecord): Record<string, unknown> {
  const poc = toPoCRecord(
    record,
    record.offline_id as string,
    record.timestamp_local as string,
    record.submitter_identity_hash as string,
  );
  const body = buildCasePayload(poc);
  // Notifications are worded in the language the citizen reported in.
  if (typeof record.locale === "string") body.locale = record.locale;
  return body;
}

let inFlight = false;

/**
 * Deliver every due citizen submission. Safe to call from any trigger, as often as wanted: a no-op
 * offline, while another flush runs, with no session, or with a staff session signed in.
 */
export async function flushCitizenOutbox(now: number = Date.now()): Promise<FlushResult> {
  const result: FlushResult = { attempted: 0, synced: [], failed: [] };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ...result, skipped: "offline" };
  }
  if (inFlight) return { ...result, skipped: "in-flight" };
  inFlight = true;
  try {
    const pending = await getPendingCitizenSubmissions();
    const due = pending.filter((r) => {
      const next = r.citizen_next_attempt_at;
      return typeof next !== "number" || next <= now;
    });
    if (due.length === 0) return result;

    const token = await getAccessToken();
    if (!token) return { ...result, skipped: "no-session" };
    // A staff account signed in on the same browser must not file a citizen's report under its
    // own identity (the server would refuse it anyway -- or worse, treat it as officer-assisted).
    if (staffRoleFromToken(token)) return { ...result, skipped: "staff-session" };

    for (const record of due) {
      const offlineId = record.offline_id as string;
      result.attempted += 1;

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/api/v1/cases/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payloadFor(record)),
        });
      } catch {
        await scheduleRetry(record, now, "network");
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        let canonical: string | undefined;
        try {
          canonical = ((await res.json()) as { canonical_id?: string }).canonical_id;
        } catch {
          canonical = undefined;
        }
        if (!canonical) {
          await scheduleRetry(record, now, "bad_response");
          continue;
        }
        await updateDraft(offlineId, {
          canonical_id: canonical,
          sync_status: "synced",
          citizen_synced_at: new Date(now).toISOString(),
          citizen_sync_error: null,
        });
        result.synced.push({ offline_id: offlineId, canonical_id: canonical });
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("hec-case-synced", {
              detail: { offline_id: offlineId, canonical_id: canonical },
            }),
          );
        }
        continue;
      }

      if (res.status === 401) {
        // The session expired. Every later record would fail the same way; keep them all pending
        // and try again once the citizen has signed in.
        await scheduleRetry(record, now, "session_expired");
        break;
      }

      let code = "";
      try {
        code = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        code = "";
      }

      if (res.status === 400 || (res.status === 403 && code === "not_registered")) {
        // Retrying an identical request cannot succeed. Surfaced, not dropped: the receipt stays,
        // and the reason is on the record for the citizen's screen.
        await updateDraft(offlineId, {
          sync_status: "failed",
          citizen_sync_error: code || `http_${res.status}`,
        });
        result.failed.push({ offline_id: offlineId, error: code || `http_${res.status}` });
        continue;
      }

      // 403 forbidden (wrong account type), 5xx, anything else: transient or not ours to decide.
      await scheduleRetry(record, now, code || `http_${res.status}`);
    }
    return result;
  } finally {
    inFlight = false;
  }
}

async function scheduleRetry(record: OutboxRecord, now: number, error: string): Promise<void> {
  const attempts = (typeof record.citizen_sync_attempts === "number" ? record.citizen_sync_attempts : 0) + 1;
  await updateDraft(record.offline_id as string, {
    citizen_sync_attempts: attempts,
    citizen_next_attempt_at: now + backoffMs(attempts),
    citizen_sync_error: error,
  }).catch(() => {});
}

/** Test seam: reset the re-entrancy guard between tests. */
export function __resetCitizenOutboxForTests(): void {
  inFlight = false;
}
