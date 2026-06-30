// Public claim-status helpers (Story 2.5). Pure/DOM-free so they are unit-testable
// and shared by the status page, StatusCard, and the QR flow.

export interface CaseStatus {
  canonical_id: string | null;
  offline_id: string;
  status: string;
  // The backend emits null when a case has no updated_at timestamp.
  updated_at: string | null;
  approved_amount?: number;
}

export const KNOWN_STATUSES = ["Submitted", "Under Review", "Approved", "Rejected"] as const;

// Strict RFC-4122 v4 UUID (CRITICAL #5) and canonical HEC-YYYY-NNNN.
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEC_RE = /^HEC-\d{4}-\d+$/i;

export function isValidReference(ref: string): boolean {
  const r = ref.trim();
  return UUID_V4_RE.test(r) || HEC_RE.test(r);
}

/** Message-key-safe form of a status label: "Under Review" → "UnderReview". */
export function statusKey(status: string): string {
  return status.replace(/\s+/g, "");
}

/** Approved amount is shown only for an Approved claim that carries an amount. */
export function showApprovedAmount(s: Pick<CaseStatus, "status" | "approved_amount">): boolean {
  return s.status === "Approved" && typeof s.approved_amount === "number";
}
