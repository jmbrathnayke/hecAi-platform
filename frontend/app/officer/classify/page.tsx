"use client";

// Officer on-device AI classification (Story 3.3). Lives under app/officer/* (English-only,
// FR-9.3, middleware-guarded) — NOT under app/[locale] — consistent with the officer login /
// dashboard tree established in Stories 3.1/3.2. Capture → quality check → on-device inference
// → AI Result Card, all offline-capable via the SW-precached MobileNetV2 (Story 3.2). The
// result never auto-advances the case; the officer must tap Accept or Override (NFR-6.1).

import { useEffect, useRef, useState } from "react";
import { assessImageQuality } from "@/lib/imageQuality";
import { classifyImage, type ClassId, type ClassificationResult } from "@/lib/mobilenet";
import { deriveCaseCategory } from "@/lib/classification";
import { saveClassification, getCase } from "@/lib/indexeddb";
import { getDraftId, getOrCreateDraftId } from "@/lib/draft";
import { AIResultCard } from "@/components/AIResultCard";

type Status = "idle" | "classifying" | "result" | "error";
type Decision = "accepted" | "override" | null;

// Reverse of deriveCaseCategory: reconstruct an equivalent per-photo class set from a persisted
// case-level rollup. Lets us re-hydrate the accumulator after a reload so the rollup stays
// monotonic (never regresses "combined" → a single class) without persisting a separate array.
function classIdsFromCaseCategory(category: unknown): ClassId[] {
  switch (category) {
    case "combined":
      return ["crop_damage", "property_damage"];
    case "crop_damage":
      return ["crop_damage"];
    case "property_damage":
      return ["property_damage"];
    default:
      return [];
  }
}

export default function OfficerClassifyPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [qualityWarning, setQualityWarning] = useState(false);
  const [decision, setDecision] = useState<Decision>(null);
  // Accumulated per-photo classes for this case, so the case-level rollup (FR-2.1) reflects
  // every photo the officer has classified in this session, not just the latest.
  const classIdsRef = useRef<ClassId[]>([]);
  // Serializes captures: overlapping in-flight runs would interleave classIdsRef pushes and
  // concurrent draft writes (the button `disabled` only guards after the next React render).
  const inFlightRef = useRef(false);

  // Epic 2 retro lesson: guard state updates after unmount for in-flight async work.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    // Re-hydrate the per-photo accumulator from the persisted draft so the case rollup does not
    // regress (e.g. "combined" → a single class) if the officer reloads mid-case. Best-effort:
    // a missing draft / read failure just starts from an empty set.
    const draftId = getDraftId();
    if (draftId) {
      getCase(draftId)
        .then((draft) => {
          if (!mountedRef.current || !draft || classIdsRef.current.length > 0) return;
          classIdsRef.current = classIdsFromCaseCategory(draft.case_category);
        })
        .catch(() => {});
    }
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (inFlightRef.current) return; // ignore overlapping captures — one classification at a time
    inFlightRef.current = true;

    setStatus("classifying");
    setQualityWarning(false);
    setDecision(null);

    try {
      // AC1: quality check runs first; a failure warns but does not block classification.
      try {
        const quality = await assessImageQuality(file);
        if (!mountedRef.current) return;
        if (quality.blurry || quality.poorExposure) setQualityWarning(true);
      } catch {
        // Undecodable/non-image file — surface as an error, nothing to classify.
        if (mountedRef.current) setStatus("error");
        return;
      }

      const classification = await classifyImage(file);
      if (!mountedRef.current) return;

      // AC7 + AC8: persist the latest per-photo result and the recomputed case-level rollup.
      // Derive from the prospective set but commit the append to classIdsRef only AFTER the
      // write succeeds — a failed save must not leave a phantom class in the rollup.
      const draftId = getOrCreateDraftId();
      const nextClassIds = [...classIdsRef.current, classification.classId];
      await saveClassification(draftId, {
        ai_category: classification.classId,
        ai_confidence: classification.confidence,
        ai_severity: classification.severity,
        ai_processing_time_ms: classification.processingTimeMs,
        ai_model_version: classification.modelVersion,
        case_category: deriveCaseCategory(nextClassIds),
      });
      classIdsRef.current = nextClassIds;
      if (!mountedRef.current) return;

      setResult(classification);
      setStatus("result");
    } catch {
      if (mountedRef.current) setStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <div className="max-w-md mx-auto space-y-design-4">
        <h1 className="text-title text-ink-primary">Damage Classification</h1>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          data-testid="classify-file-input"
          onChange={(e) => void handleCapture(e)}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={status === "classifying"}
          className="w-full min-h-primary-btn bg-forest text-ink-on-dark text-headline font-semibold rounded-md disabled:opacity-60"
        >
          {status === "classifying" ? "Analyzing photo..." : "Capture damage photo"}
        </button>

        {qualityWarning && (
          <p role="alert" className="text-caption text-status-warning">
            Photo quality looks low (blurry or poorly lit). You can retake it or continue.
          </p>
        )}

        {status === "error" && (
          <p role="alert" className="text-caption text-status-error">
            Could not classify this photo. Please retake it and try again.
          </p>
        )}

        {status === "result" && result && (
          <>
            <AIResultCard
              classId={result.classId}
              severity={result.severity}
              confidence={result.confidence}
              processingTimeMs={result.processingTimeMs}
              onAccept={() => setDecision("accepted")}
              onOverride={() => setDecision("override")}
            />
            {decision === "accepted" && (
              <p className="text-label text-status-success">Assessment accepted.</p>
            )}
            {decision === "override" && (
              <p className="text-label text-ink-secondary">Select the correct category to override.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
