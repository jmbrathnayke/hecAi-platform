"use client";

// Officer on-device AI classification (Story 3.3). Lives under app/officer/* (English-only,
// FR-9.3, middleware-guarded) — NOT under app/[locale] — consistent with the officer login /
// dashboard tree established in Stories 3.1/3.2. Capture → quality check → on-device inference
// → AI Result Card, all offline-capable via the SW-precached MobileNetV2 (Story 3.2). The
// result never auto-advances the case; the officer must tap Accept or Override (NFR-6.1).

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { assessImageQuality } from "@/lib/imageQuality";
import { classifyImage, type ClassId, type ClassificationResult } from "@/lib/mobilenet";
import { deriveCaseCategory } from "@/lib/classification";
import { saveClassification, saveOverride, getCase } from "@/lib/indexeddb";
import { getDraftId, getOrCreateDraftId, clearDraftId } from "@/lib/draft";
import { AIResultCard } from "@/components/AIResultCard";
import { OverrideForm } from "@/components/OverrideForm";

type Status = "idle" | "classifying" | "result" | "error";
type Decision = "accepted" | "override" | "overridden" | null;

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
  const t = useTranslations("officer");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [qualityWarning, setQualityWarning] = useState(false);
  const [decision, setDecision] = useState<Decision>(null);
  // Override-save failed (distinct from a classification failure): the result already exists,
  // so we keep the result view + the officer's typed reason instead of a "retake photo" error.
  const [overrideError, setOverrideError] = useState(false);
  // Serializes override confirms the same way inFlightRef serializes captures (the Confirm
  // button stays enabled during the async save, so a double-tap could fire two writes).
  const overrideSavingRef = useRef(false);
  // Accumulated per-photo classes for this case, so the case-level rollup (FR-2.1) reflects
  // every photo the officer has classified in this session, not just the latest.
  const classIdsRef = useRef<ClassId[]>([]);
  // Serializes captures: overlapping in-flight runs would interleave classIdsRef pushes and
  // concurrent draft writes (the button `disabled` only guards after the next React render).
  const inFlightRef = useRef(false);
  // Object URLs for the photos classified in THIS session, for the mockup's photo strip. Held
  // in a ref alongside state purely so the unmount cleanup can revoke them without needing
  // `thumbnails` in the effect's dependency array (which would revoke on every capture).
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbnailsRef = useRef<string[]>([]);

  // The strip is decoration. createObjectURL failing (or being unavailable) must never cost the
  // officer a classification they already waited for, so this swallows its own errors rather
  // than letting them escape into handleCapture's catch and flip the screen to "error".
  function addThumbnail(file: File) {
    try {
      const url = URL.createObjectURL(file);
      thumbnailsRef.current = [...thumbnailsRef.current, url];
      setThumbnails(thumbnailsRef.current);
    } catch {
      /* no thumbnail for this photo — the classification itself is unaffected */
    }
  }

  // Ref-only (no setState) so the unmount cleanup can call it safely. Guarded for the same
  // reason as addThumbnail: revoke is best-effort cleanup, never a failure path.
  function revokeThumbnails() {
    try {
      thumbnailsRef.current.forEach((url) => URL.revokeObjectURL(url));
    } catch {
      /* nothing to revoke / API unavailable */
    }
    thumbnailsRef.current = [];
  }

  function clearThumbnails() {
    revokeThumbnails();
    setThumbnails([]);
  }

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
      // Revoke every object URL the strip created — without this each capture leaks a blob
      // for the lifetime of the document.
      revokeThumbnails();
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

      addThumbnail(file);
      setResult(classification);
      setStatus("result");
    } catch {
      if (mountedRef.current) setStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  // Story 3.4: the officer overrides the AI class for the just-classified photo. The override is
  // additive — ai_category/ai_confidence/ai_severity stay intact; original_ai_category snapshots
  // the AI's class. case_category is recomputed by substituting the corrected class for THIS
  // photo (the last element of classIdsRef, appended on capture). We commit the classIdsRef
  // mutation only AFTER the write resolves (3.3 discipline) so a failed save leaves no phantom.
  async function handleOverrideConfirm(category: ClassId, reason: string) {
    if (!result) return;
    if (overrideSavingRef.current) return; // ignore double-taps while a save is in flight
    overrideSavingRef.current = true;
    setOverrideError(false);
    const draftId = getOrCreateDraftId();
    const nextClassIds = [...classIdsRef.current];
    if (nextClassIds.length > 0) {
      nextClassIds[nextClassIds.length - 1] = category;
    } else {
      nextClassIds.push(category);
    }
    // D1: correcting to the class the AI already predicted is not a disagreement — record it as
    // a non-override so the override-rate metric (NFR-6.3) stays honest; the reason is kept.
    const isRealOverride = category !== result.classId;
    try {
      await saveOverride(draftId, {
        override_applied: isRealOverride,
        override_category: category,
        override_reason: reason,
        original_ai_category: result.classId,
        case_category: deriveCaseCategory(nextClassIds),
      });
    } catch {
      // Only the override write failed — classification already succeeded. Keep the result view
      // (and the officer's typed reason) and surface an override-specific, retryable error.
      if (mountedRef.current) setOverrideError(true);
      return;
    } finally {
      overrideSavingRef.current = false;
    }
    classIdsRef.current = nextClassIds;
    if (!mountedRef.current) return;
    setDecision("overridden");
  }

  // Story 3.5 (AC7): start a fresh case. Clears the draft id so the next capture gets a new
  // offline_id, and empties the per-photo accumulator so the previous case's photos do NOT
  // bleed into the next case's case_category rollup (closes the 3.3 "no new-case reset" deferral).
  function handleStartNewCase() {
    clearDraftId();
    classIdsRef.current = [];
    clearThumbnails();
    setResult(null);
    setDecision(null);
    setOverrideError(false);
    setQualityWarning(false);
    setStatus("idle");
  }

  return (
    <main className="flex-1 bg-surface-base px-design-4 py-design-6">
      <div className="max-w-md mx-auto space-y-design-4">
        <div className="flex items-center justify-between gap-design-3">
          <h1 className="text-title text-ink-primary">{t("classify.title")}</h1>
          <button
            type="button"
            onClick={handleStartNewCase}
            className="min-h-touch-target text-label font-semibold text-forest underline"
          >
            {t("classify.startNewCase")}
          </button>
        </div>

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
          {status === "classifying" ? t("classify.analyzing") : t("classify.capture")}
        </button>

        {qualityWarning && (
          <p role="alert" className="text-caption text-status-warning">
            {t("classify.qualityWarning")}
          </p>
        )}

        {status === "error" && (
          <p role="alert" className="text-caption text-status-error">
            {t("classify.classifyError")}
          </p>
        )}

        {/* Photo strip (mockup): the running set of photos classified for this case. The last
            one is the subject of the result card below, so it carries the forest ring. */}
        {thumbnails.length > 0 && (
          <div>
            <p className="text-caption font-medium text-ink-secondary">
              {t("classify.photosCaptured", { count: thumbnails.length })}
            </p>
            <ul
              aria-label={t("classify.photoStripAria")}
              className="mt-design-2 flex gap-design-2 overflow-x-auto pb-design-1"
            >
              {thumbnails.map((url, i) => (
                <li key={url} className="shrink-0">
                  {/* Plain <img>: these are blob: object URLs, which next/image cannot
                      optimise, and this screen must work fully offline anyway. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt=""
                    className={`h-16 w-20 rounded-sm border-2 object-cover ${
                      i === thumbnails.length - 1 ? "border-forest" : "border-border-default"
                    }`}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {status === "result" && result && (
          <>
            <AIResultCard
              classId={result.classId}
              severity={result.severity}
              confidence={result.confidence}
              processingTimeMs={result.processingTimeMs}
              modelVersion={result.modelVersion}
              onAccept={() => {
                // Once an override is recorded, Accept must not flip the UI to "accepted"
                // while the persisted draft still says overridden (contradictory record).
                if (decision !== "overridden") setDecision("accepted");
              }}
              onOverride={() => {
                setOverrideError(false);
                setDecision("override");
              }}
            />
            {decision === "accepted" && (
              <p className="text-label text-status-success">{t("classify.accepted")}</p>
            )}
            {decision === "override" && (
              <>
                <OverrideForm
                  currentCategory={result.classId}
                  onConfirm={(category, reason) => void handleOverrideConfirm(category, reason)}
                  onCancel={() => {
                    setOverrideError(false);
                    setDecision(null);
                  }}
                />
                {overrideError && (
                  <p role="alert" className="text-caption text-status-error">
                    {t("classify.overrideError")}
                  </p>
                )}
              </>
            )}
            {decision === "overridden" && (
              <p className="text-label text-status-success">{t("classify.overridden")}</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
