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
import { OfficerTopBar } from "@/components/OfficerTopBar";
import { CameraCapture } from "@/components/CameraCapture";
import { PhotoStrip } from "@/components/PhotoStrip";
import { FieldNotes } from "@/components/FieldNotes";
import { Plus } from "@phosphor-icons/react";
import { touchButtonStyles } from "@/components/admin/ui";

type Status = "idle" | "classifying" | "result" | "error";
type Decision = "accepted" | "override" | "overridden" | null;

// Mockup: "2 of 10 photos taken". Matches the citizen photo step's cap (MAX_PHOTOS in
// app/[locale]/report/photos) so a case can never carry more photos when an officer builds it.
const MAX_PHOTOS = 10;

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
  // Remount key for FieldNotes. That component owns its text in local state (so typing is not
  // routed through this page on every keystroke), which means "Start new case" has to discard
  // the instance outright — otherwise the previous case's note would greet the next citizen.
  const [notesKey, setNotesKey] = useState(0);

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

  // Receives a still from the in-app shutter or a file from the gallery fallback — both arrive
  // as a File, so the pipeline below is identical for either route.
  async function handleCapture(file: File) {
    if (inFlightRef.current) return; // ignore overlapping captures — one classification at a time
    // Hard cap (mockup's "N of 10"): silently ignore rather than error — the camera's shutter
    // and gallery button are already disabled at the cap, so reaching here means a race.
    if (thumbnailsRef.current.length >= MAX_PHOTOS) return;
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
      } catch (err) {
        // Undecodable/non-image file — surface as an error, nothing to classify.
        console.error("[classify] image quality check failed; file is not decodable", err);
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
        // The gate's record travels with the class, so an offline submission syncs the same
        // evidence an online assessment posts (lib/poc.ts forwards these to inference_log).
        ai_gate_version: classification.gateVersion,
        ai_gate_applied: classification.gateApplied,
        ai_out_of_domain: classification.outOfDomain,
        ai_domain_distance: classification.domainDistance,
        ai_raw_prediction: classification.rawClassId,
        ai_raw_confidence: classification.rawConfidence,
      });
      classIdsRef.current = nextClassIds;
      if (!mountedRef.current) return;

      addThumbnail(file);
      setResult(classification);
      setStatus("result");
    } catch (err) {
      // "Could not classify this photo. Please retake it and try again." is shown for every
      // failure in this block — model load, inference, IndexedDB write. Retaking the photo fixes
      // none of those, so without the cause the copy actively misdirects. `cause` carries the
      // underlying tfjs error when it came from ModelNotAvailableError.
      console.error(
        "[classify] classification failed",
        { online: navigator.onLine },
        err instanceof Error ? (err.cause ?? err) : err,
      );
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
    setNotesKey((n) => n + 1);
    setResult(null);
    setDecision(null);
    setOverrideError(false);
    setQualityWarning(false);
    setStatus("idle");
  }

  const atMax = thumbnails.length >= MAX_PHOTOS;

  return (
    // No horizontal padding on <main>: the top bar, the camera viewport and the instruction
    // strip are full-bleed in the mockup. Only the scrolling panel below them is inset.
    <main className="flex-1 bg-surface-base">
      <div className="mx-auto w-full max-w-md">
        <OfficerTopBar
          label={t("classify.title")}
          action={
            <button
              type="button"
              onClick={handleStartNewCase}
              className={`${touchButtonStyles.quiet} shrink-0`}
            >
              <Plus aria-hidden="true" size={16} />
              {t("classify.startNewCase")}
            </button>
          }
        />

        <CameraCapture
          onCapture={(file) => void handleCapture(file)}
          disabled={status === "classifying"}
          busyLabel={t("classify.analyzing")}
          atMax={atMax}
          thumbnails={thumbnails}
          fileInputTestId="classify-file-input"
        />

        {/* Instruction strip (mockup): what to shoot, and how many are banked so far. */}
        <div className="border-b border-border-subtle bg-surface-raised px-design-5 py-design-3 text-center">
          <p className="text-label text-ink-secondary">
            <span aria-hidden="true">📸 </span>
            {atMax ? t("camera.maxReached", { max: MAX_PHOTOS }) : t("camera.instruction")}
          </p>
          <p className="text-caption text-ink-disabled">
            {t("camera.count", { count: thumbnails.length, max: MAX_PHOTOS })}
          </p>
        </div>

        <div className="space-y-design-4 px-design-4 py-design-4">
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

          {/* The running set of photos classified for this case. The last one is the subject of
              the result card below, so PhotoStrip rings it in forest. */}
          <PhotoStrip
            thumbnails={thumbnails}
            countLabel={t("classify.photosCaptured", { count: thumbnails.length })}
            ariaLabel={t("classify.photoStripAria")}
          />

          {status === "result" && result && (
            <>
              <AIResultCard
                classId={result.classId}
                severity={result.severity}
                confidence={result.confidence}
                processingTimeMs={result.processingTimeMs}
                modelVersion={result.modelVersion}
                outOfDomain={result.outOfDomain}
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

              {/* Mockup places the note between the result card and the CTAs. Keyed on the draft
                  generation so "Start new case" gives the next citizen an empty box rather than
                  the previous officer note (the component holds its text in local state). */}
              <FieldNotes key={notesKey} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
