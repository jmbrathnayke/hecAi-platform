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
}

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
 * Best-effort online submission. Posts the PoC to the backend with a bearer token.
 * Returns the canonical id on success, or null on any failure (offline, 401, 5xx) —
 * the caller keeps the PoC in `pending` and relies on background sync (Epic 4).
 * The QR/offline receipt never depends on this call (CRITICAL #3).
 */
export async function submitCaseOnline(record: PoCRecord, token: string): Promise<SubmitResult | null> {
  try {
    // Officer fields are added only when present so the citizen request body is unchanged
    // (and the backend's officer-aware branch stays dormant for anonymous submissions).
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
    }
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
