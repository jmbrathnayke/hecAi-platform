// Removing a photo the officer did not mean to take (2026-10-07).
//
// The user reported a dark red frame that had gone into a case by accident (a covered lens) with no
// way to take it out. The classify screen and the officer submission flow keep the same per-session
// state: one object URL, one classification and one class per photo, oldest first. The case draft
// in IndexedDB holds the LATEST photo's classification plus the case-level rollup over every class.
// This works out what removing photo `index` does to all of that, as one pure function, so both
// screens behave identically and the rules are testable without a browser.
//
// `classIds` may be longer than `results`: after a reload the rollup is re-hydrated from the
// draft's case_category, but the photos themselves (object URLs) are gone. Those leading classes
// belong to no photo on screen and are never removed here; the session's photos are the tail.
import { deriveCaseCategory } from "@/lib/classification";
import type { ClassId, ClassificationResult } from "@/lib/mobilenet";

export interface PhotoRemoval {
  classIds: ClassId[];
  results: ClassificationResult[];
  /** The photo the result card should now describe, or null when no session photo is left. */
  current: ClassificationResult | null;
  /** True when the card's subject changed (the removed photo was the one it showed). */
  currentChanged: boolean;
  /** Fields to merge into the case draft. Undefined values clear a field. */
  draftFields: Record<string, unknown>;
}

/** The draft fields that describe one classified photo. The same set the capture handlers write. */
export function classificationFields(r: ClassificationResult): Record<string, unknown> {
  return {
    ai_category: r.classId,
    ai_confidence: r.confidence,
    ai_severity: r.severity,
    ai_processing_time_ms: r.processingTimeMs,
    ai_model_version: r.modelVersion,
    ai_gate_version: r.gateVersion,
    ai_gate_applied: r.gateApplied,
    ai_out_of_domain: r.outOfDomain,
    ai_domain_distance: r.domainDistance,
    ai_raw_prediction: r.rawClassId,
    ai_raw_confidence: r.rawConfidence,
  };
}

const CLEARED_CLASSIFICATION: Record<string, unknown> = {
  ai_category: undefined,
  ai_confidence: undefined,
  ai_severity: undefined,
  ai_processing_time_ms: undefined,
  ai_model_version: undefined,
  ai_gate_version: undefined,
  ai_gate_applied: undefined,
  ai_out_of_domain: undefined,
  ai_domain_distance: undefined,
  ai_raw_prediction: undefined,
  ai_raw_confidence: undefined,
};

// An override always refers to the latest photo, so it cannot outlive that photo's removal.
const CLEARED_OVERRIDE: Record<string, unknown> = {
  override_applied: undefined,
  override_category: undefined,
  override_reason: undefined,
  original_ai_category: undefined,
};

export function planPhotoRemoval(
  classIds: ClassId[],
  results: ClassificationResult[],
  index: number,
): PhotoRemoval | null {
  if (index < 0 || index >= results.length) return null;
  const offset = classIds.length - results.length;
  if (offset < 0) return null; // inconsistent state: refuse rather than guess

  const nextResults = results.filter((_, i) => i !== index);
  const nextClassIds = classIds.filter((_, i) => i !== offset + index);
  const removedCurrent = index === results.length - 1;
  const current = nextResults.length > 0 ? nextResults[nextResults.length - 1] : null;
  const rollup = nextClassIds.length > 0 ? deriveCaseCategory(nextClassIds) : undefined;

  let draftFields: Record<string, unknown>;
  if (!removedCurrent) {
    // An earlier photo: only the case-level rollup changes.
    draftFields = { case_category: rollup };
  } else if (current) {
    // The latest photo went: the previous one becomes the case's classification again, and the
    // override recorded against the removed photo goes with it.
    draftFields = { ...classificationFields(current), ...CLEARED_OVERRIDE, case_category: rollup };
    // The class the rollup holds for the new current photo is its own AI class again.
    nextClassIds[nextClassIds.length - 1] = current.classId;
    draftFields.case_category = deriveCaseCategory(nextClassIds);
  } else {
    // No session photo left. Classes re-hydrated from before a reload still stand.
    draftFields = offset > 0
      ? { case_category: rollup }
      : { ...CLEARED_CLASSIFICATION, ...CLEARED_OVERRIDE, case_category: undefined };
  }

  return {
    classIds: nextClassIds,
    results: nextResults,
    current,
    currentChanged: removedCurrent,
    draftFields,
  };
}
