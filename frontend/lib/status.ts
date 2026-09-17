// Public claim-status helpers (Story 2.5). Pure/DOM-free so they are unit-testable
// and shared by the status page, StatusCard, and the QR flow.

export interface CaseStatus {
  canonical_id: string | null;
  offline_id: string;
  status: string;
  // The backend emits null when a case has no updated_at timestamp.
  updated_at: string | null;
  /**
   * Finer, derived position in the governance workflow (backend app/domain/workflow.py). Optional
   * so a response from an older backend still renders.
   */
  stage?: string;
  /**
   * The Divisional Secretariat's recorded final compensation amount -- the only amount the public
   * page shows. The AI-assisted estimate and the DWC administrator's recommendation are never sent.
   */
  final_amount?: number;
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

/** The final amount is shown only once the DS office has decided it, and never for a rejection. */
export function showFinalAmount(s: Pick<CaseStatus, "status" | "final_amount">): boolean {
  return (
    (s.status === "Approved" || s.status === "Payment Processed") &&
    typeof s.final_amount === "number"
  );
}

/** Workflow stages the status page can describe, in journey order, plus the terminal rejection. */
export const WORKFLOW_STAGES = [
  "submitted",
  "officer_review",
  "officer_assessed",
  "dwc_approved",
  "ds_final_decided",
  "payment_processed",
  "rejected",
] as const;

export function isKnownStage(stage: unknown): stage is (typeof WORKFLOW_STAGES)[number] {
  return typeof stage === "string" && (WORKFLOW_STAGES as readonly string[]).includes(stage);
}

// ---------------------------------------------------------------- claim journey (FR-6.1)

/**
 * Every status the platform can report, in the order a claim passes through them.
 *
 * DISTINCT FROM KNOWN_STATUSES, which is the officer dashboard's FILTER list and stops at
 * "Rejected". StatusCard used that list to decide whether it could translate a status, so a claim
 * that had been PAID — the outcome the whole workflow exists to reach — fell through to the raw
 * English string and a neutral grey chip, in all three languages. The translations were present in
 * every message file the whole time; only the membership test was wrong.
 */
export const CLAIM_JOURNEY = [
  "Submitted",
  "Under Review",
  "Approved",
  "Payment Processed",
] as const;

/** Statuses with a translated label, including the terminal rejection that is not on the journey. */
export const TRANSLATED_STATUSES = [...CLAIM_JOURNEY, "Rejected"] as const;

export function isTranslatedStatus(status: string): boolean {
  return (TRANSLATED_STATUSES as readonly string[]).includes(status);
}

/**
 * -> how far along the journey this status sits, or -1 for one that is not on it.
 *
 * "Rejected" is deliberately off the journey rather than at the end of it: a rejected claim did not
 * travel further than a pending one, and rendering it as the final step of a progress bar would
 * tell a family their claim had completed.
 */
export function journeyIndex(status: string): number {
  return (CLAIM_JOURNEY as readonly string[]).indexOf(status);
}
