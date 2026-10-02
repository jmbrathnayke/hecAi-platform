// Proof of Claim (PoC) assembly + submission (FR-3.1–3.4).
//
// The PoC is the citizen's legal receipt. It is built CLIENT-SIDE and rendered
// immediately on submit — before any network round-trip — so citizens with no
// connectivity still get evidence (FR-3.2). The QR always encodes the UUID-v4
// `offline_id` (PRD Addendum A3); the canonical HEC-YYYY-NNNN is assigned by the
// backend on sync and shown as display-only text.
import { putCase } from "@/lib/indexeddb";
import { uuidv4 } from "@/lib/uuid";

export interface PoCRecord {
  offline_id: string;
  timestamp_local: string;
  gps: { lat: number; lng: number } | null;
  damage_category: string | null;
  submitter_identity_hash: string;
  sync_status: "pending" | "synced";
  // Officer-assisted submission (Story 3.5, FR-1.2). Present only on the officer path; the
  // anonymous citizen path leaves both undefined so its request body is byte-for-byte unchanged.
  submitted_by_officer?: boolean;
  officer_id?: string;
  // District/DS-division picker (Story 5.2 Task 7) — optional on every path, undefined
  // (not null) when absent so the existing toPoCRecord byte-shape tests stay unaffected.
  district?: string;
  /** Story 8.5. The registered household this case is filed against. Required by the
   *  FR-10.3 submit gate on the officer-assisted path; absent on the citizen path, where
   *  the backend resolves the household from the JWT instead. */
  household_ref?: string;
  ds_division?: string;
  // AI severity (Story 5.2 Task 8) — only ever present on officer-classified drafts;
  // citizen self-service drafts have no AI classification step and never set this.
  ai_severity?: string;
  /**
   * Final governance workflow. The officer's on-device MobileNetV2 result (and override, if any)
   * for an officer-assisted draft, in the research log's field names. Sent only on the officer
   * path; the backend records it in inference_log and marks the case officer-assessed.
   */
  ai_classification?: Record<string, unknown>;
  /**
   * The family's own description of the damage (Step 3, optional). Until migration 040 this was
   * collected and never sent, so no officer, administrator or Divisional Secretariat ever read it.
   * Undefined (not empty) when the family wrote nothing, so a report without one keeps the exact
   * request body it always had.
   */
  description?: string;
}

/** The form's limit (report/damage/page.tsx). The server keeps up to twice this. */
export const MAX_DESCRIPTION = 500;

export interface SubmitResult {
  canonical_id: string;
  offline_id: string;
}

/**
 * SHA-256 of `offline_id:nicCiphertext` — a stable, non-reversible submitter
 * identity tag. Pure (only WebCrypto), so it is unit-testable.
 */
export async function computeIdentityHash(offlineId: string, nicCiphertext: string): Promise<string> {
  const input = `${offlineId}:${nicCiphertext}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Assemble a PoCRecord from a draft case. Pure (no IDB / crypto), so the field
 * mapping is unit-testable. The draft stores location as `location_lat/lng`.
 */
export function toPoCRecord(
  draft: Record<string, unknown>,
  offlineId: string,
  timestampLocal: string,
  identityHash: string,
): PoCRecord {
  const lat = draft.location_lat;
  const lng = draft.location_lng;
  const gps =
    typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
  return {
    offline_id: offlineId,
    timestamp_local: timestampLocal,
    gps,
    damage_category: typeof draft.damage_category === "string" ? draft.damage_category : null,
    submitter_identity_hash: identityHash,
    sync_status: draft.sync_status === "synced" ? "synced" : "pending",
    district: typeof draft.district === "string" ? draft.district : undefined,
    household_ref:
      typeof draft.household_ref === "string" ? draft.household_ref : undefined,
    ds_division: typeof draft.ds_division === "string" ? draft.ds_division : undefined,
    ai_severity: typeof draft.ai_severity === "string" ? draft.ai_severity : undefined,
    ai_classification: classificationFromDraft(draft),
    description: descriptionFromDraft(draft),
  };
}

/** The family's description, trimmed and capped, or undefined when there is none. */
export function descriptionFromDraft(draft: Record<string, unknown>): string | undefined {
  if (typeof draft.description !== "string") return undefined;
  const text = draft.description.trim().slice(0, MAX_DESCRIPTION);
  return text === "" ? undefined : text;
}

/**
 * The officer's classification from a draft, or undefined when the draft has none (every citizen
 * draft). Mirrors what the classify step stored (lib/indexeddb.ts saveClassification/saveOverride).
 */
export function classificationFromDraft(
  draft: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof draft.ai_category !== "string" || typeof draft.ai_model_version !== "string") {
    return undefined;
  }
  const overridden =
    draft.override_applied === true &&
    typeof draft.override_category === "string" &&
    draft.override_category !== draft.ai_category;
  return {
    model_type: "mobilenetv2",
    model_version: draft.ai_model_version,
    prediction: draft.ai_category,
    confidence: typeof draft.ai_confidence === "number" ? draft.ai_confidence : null,
    ai_processing_time_ms:
      typeof draft.ai_processing_time_ms === "number"
        ? Math.max(0, Math.round(draft.ai_processing_time_ms))
        : null,
    was_overridden: overridden,
    override_category: overridden ? draft.override_category : null,
    override_reason: overridden && typeof draft.override_reason === "string" ? draft.override_reason : null,
    // Open-set gate (lib/oodGate.ts). Forwarded only when the draft actually carries them: a
    // draft classified before the gate existed must still sync, and the server distinguishes
    // "absent" from "the gate ran and passed" (inference_log.parse_gate_fields). Each value is
    // re-checked here because a draft is client-side storage, not a trusted source.
    ...(typeof draft.ai_gate_version === "string"
      ? {
          ai_gate_version: draft.ai_gate_version,
          ai_gate_applied: draft.ai_gate_applied === true,
          ai_out_of_domain: draft.ai_out_of_domain === true,
          ai_domain_distance:
            typeof draft.ai_domain_distance === "number" ? draft.ai_domain_distance : null,
          ai_raw_prediction:
            typeof draft.ai_raw_prediction === "string" ? draft.ai_raw_prediction : null,
          ai_raw_confidence:
            typeof draft.ai_raw_confidence === "number" ? draft.ai_raw_confidence : null,
        }
      : {}),
  };
}

/**
 * Build the PoC from the IDB draft (generating an `offline_id`/timestamp on first
 * build), persist the PoC fields onto the case record with `sync_status: pending`,
 * and return the record. Idempotent across re-renders: a previously-built PoC keeps
 * its original `offline_id` and `timestamp_local`.
 */
export async function buildPoC(draft: Record<string, unknown>): Promise<PoCRecord> {
  const offlineId =
    (typeof draft.offline_id === "string" && draft.offline_id) || uuidv4();
  const timestampLocal =
    (typeof draft.timestamp_local === "string" && draft.timestamp_local) ||
    new Date().toISOString();
  const nicCiphertext =
    typeof draft.reporter_nic_ciphertext === "string" ? draft.reporter_nic_ciphertext : "";

  const identityHash = await computeIdentityHash(offlineId, nicCiphertext);
  const record = toPoCRecord(draft, offlineId, timestampLocal, identityHash);

  // Merge onto the existing draft — keep location/photos/ciphertexts already stored.
  // Best-effort: the receipt is fully in-memory, so a persistence failure (IDB quota /
  // blocked) must NOT deny the citizen their evidence (offline-first, FR-3.2).
  try {
    await putCase({ ...draft, ...record, offline_id: offlineId });
  } catch {
    /* receipt still returned and rendered; sync/retry handled later (Epic 4) */
  }
  return record;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * Shape the case-submission request body from a PoCRecord. Shared by the immediate
 * one-shot submit below and Story 4.1's background sync queue (lib/syncQueue.ts), so a
 * case that misses the one-shot attempt is retried with byte-identical payload shape.
 * Officer fields are added only when present so the citizen request body is unchanged
 * (and the backend's officer-aware branch stays dormant for anonymous submissions).
 */
export function buildCasePayload(record: PoCRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    offline_id: record.offline_id,
    timestamp_local: record.timestamp_local,
    gps: record.gps,
    damage_category: record.damage_category,
    submitter_identity_hash: record.submitter_identity_hash,
  };
  if (record.submitted_by_officer) {
    body.submitted_by_officer = true;
    body.officer_id = record.officer_id;
    // Only ever on the officer path: a citizen request body never carries a classification.
    if (record.ai_classification) body.ai_classification = record.ai_classification;
  }
  // District/DS-division (Story 5.2 Task 7) and AI severity (Task 8) — additive, only
  // included when present so the anonymous citizen request body stays unchanged when
  // neither was captured.
  // Story 8.4/8.5: the gate needs this on the officer-assisted path. district/ds_division
  // below are now ignored by the backend (it copies them from the household, FR-10.6) but
  // are still sent — a queued draft from before Epic 8 carries them, and the shape of this
  // payload is shared with the sync queue.
  if (record.household_ref) body.household_ref = record.household_ref;
  if (record.district) body.district = record.district;
  if (record.ds_division) body.ds_division = record.ds_division;
  if (record.ai_severity) body.ai_severity = record.ai_severity;
  // Only when the family wrote one: the staff who verify, approve and pay the claim read it beside
  // the photographs (migration 040).
  if (record.description) body.description = record.description;
  return body;
}

/**
 * Best-effort online submission. Posts the PoC to the backend with a bearer token.
 * Returns the canonical id on success, or null on any failure (offline, 401, 5xx) —
 * the caller keeps the PoC in `pending` and relies on background sync (Story 4.1).
 * The QR/offline receipt never depends on this call (CRITICAL #3).
 */
export async function submitCaseOnline(record: PoCRecord, token: string): Promise<SubmitResult | null> {
  try {
    const body = buildCasePayload(record);
    const res = await fetch(`${API_BASE}/api/v1/cases/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<SubmitResult>;
    if (!data.canonical_id || !data.offline_id) return null;
    return { canonical_id: data.canonical_id, offline_id: data.offline_id };
  } catch {
    return null;
  }
}
