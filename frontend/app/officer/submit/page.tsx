"use client";

// Officer-Assisted Incident Submission (Story 3.5, FR-1.2). A DWC field officer submits an
// incident on behalf of a citizen who cannot operate the app. English-only officer portal
// (FR-9.3, middleware-guarded) — NOT under app/[locale]. Composes the Epic 2 lib layer
// (draft / crypto / poc / geolocation / validation) and the 3.3/3.4 components (AIResultCard,
// OverrideForm) rather than duplicating the citizen [locale]/report pages.
//
// PII discipline (NFR-3.1): the CITIZEN's NIC + mobile are AES-GCM encrypted on-device via
// lib/crypto before any IndexedDB write; plaintext never persists. officer_id is read from the
// verified session (JWT sub), never typed. The receipt is offline-first: it is built and shown
// regardless of whether the best-effort online submit succeeds (CRITICAL #3).

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { isValidNIC, isValidMobile } from "@/lib/validation";
import { getOrCreateSessionKey, encryptField } from "@/lib/crypto";
import { getCase, updateDraft, saveClassification, saveOverride } from "@/lib/indexeddb";
import { getOrCreateDraftId, getDraftId, clearDraftId } from "@/lib/draft";
import { getCurrentPosition } from "@/lib/geolocation";
import { assessImageQuality } from "@/lib/imageQuality";
import { classifyImage, type ClassId, type ClassificationResult } from "@/lib/mobilenet";
import { deriveCaseCategory } from "@/lib/classification";
import { buildPoC, submitCaseOnline } from "@/lib/poc";
import { lookupHousehold } from "@/lib/households";
import { createClient } from "@/lib/supabase";
import { AIResultCard } from "@/components/AIResultCard";
import { OverrideForm } from "@/components/OverrideForm";
import { DamageCard } from "@/components/DamageCard";
import { OFFICER_POC_NIC_KEY, clearOfficerPocMask } from "@/lib/officerPoc";
import { DistrictPicker, type DistrictSelection } from "@/components/DistrictPicker";
import { OfficerTopBar } from "@/components/OfficerTopBar";
import { CameraCapture } from "@/components/CameraCapture";
import { PhotoStrip } from "@/components/PhotoStrip";
import { FieldNotes } from "@/components/FieldNotes";
import type { LatLng } from "@/components/MapPinPicker";

const MapPinPicker = dynamic(() => import("@/components/MapPinPicker"), { ssr: false });
const SRI_LANKA_CENTER: LatLng = { lat: 7.8731, lng: 80.7718 };

// Mockup: "2 of 10 photos taken". Same cap as the citizen photo step and /officer/classify.
const MAX_PHOTOS = 10;

const STEP_ORDER = ["identity", "location", "damage", "classify", "review"] as const;

type Step = (typeof STEP_ORDER)[number];
type ClassifyStatus = "idle" | "classifying" | "result" | "error";
type Decision = "accepted" | "override" | "overridden" | null;

const DAMAGE_CATEGORIES = ["crop", "property", "combined", "none"] as const;
type DamageCategory = (typeof DAMAGE_CATEGORIES)[number];
// Damage labels are reused from the citizen `report.step3` namespace (same 4-category set) rather
// than duplicated under `officer` — see Story 6.2 CRITICAL #2.

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

export default function OfficerSubmitPage() {
  const t = useTranslations("officer");
  const tReport = useTranslations("report");
  const router = useRouter();

  const [step, setStep] = useState<Step>("identity");
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // Gates the identity step: true once the mount-time session read has settled (success or
  // failure), so "no officer_id yet" (still loading) is distinguishable from "session missing"
  // (P2) — the latter must block submission rather than silently persist a null officer_id.
  const [sessionChecked, setSessionChecked] = useState(false);

  // Identity step (the CITIZEN's identity, captured by the officer).
  const [nic, setNic] = useState("");
  const [mobile, setMobile] = useState("");
  const [nicError, setNicError] = useState<string | null>(null);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Location step.
  const [locStatus, setLocStatus] = useState<"idle" | "detecting" | "gps" | "manual">("idle");
  const [coords, setCoords] = useState<LatLng | null>(null);
  // District/DS-division (Story 5.2 Task 7) — optional, never blocks the GPS/manual flow below.
  const [district, setDistrict] = useState<DistrictSelection | null>(null);

  // Damage step.
  const [damage, setDamage] = useState<DamageCategory | null>(null);
  const [damageError, setDamageError] = useState<string | null>(null);

  // Classify step (3.3/3.4 discipline).
  const [classifyStatus, setClassifyStatus] = useState<ClassifyStatus>("idle");
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [qualityWarning, setQualityWarning] = useState(false);
  const [decision, setDecision] = useState<Decision>(null);
  const [overrideError, setOverrideError] = useState(false);

  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Mirror of the persisted field note, so the review step can show it back. FieldNotes owns
  // the editing state and the debounced write; this only receives what actually landed.
  const [fieldNotes, setFieldNotes] = useState("");

  // Object URLs for the photos captured in THIS session, for the mockup's photo strip and the
  // camera's recent-capture row. Mirrored into a ref so the unmount cleanup can revoke them
  // without listing `thumbnails` as an effect dependency (which would revoke on every capture).
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbnailsRef = useRef<string[]>([]);

  const classIdsRef = useRef<ClassId[]>([]);
  const inFlightRef = useRef(false);
  const overrideSavingRef = useRef(false);
  const mountedRef = useRef(true);

  // The strip is decoration. createObjectURL failing (or being unavailable) must never cost the
  // officer a classification they already waited for, so this swallows its own errors rather
  // than letting them escape into handleCapture's catch and flip the step to "error".
  function addThumbnail(file: File) {
    try {
      const url = URL.createObjectURL(file);
      thumbnailsRef.current = [...thumbnailsRef.current, url];
      setThumbnails(thumbnailsRef.current);
    } catch {
      /* no thumbnail for this photo — the classification itself is unaffected */
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      // officer_id/token come from the verified session, never from user input. Offline-first:
      // if the session read fails, officer_id stays null and sessionChecked still flips true
      // below so the identity step can surface the "session missing" gate (P2) instead of
      // silently letting the officer proceed with a null officer_id.
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        if (!mountedRef.current) return;
        setOfficerId(data.session?.user?.id ?? null);
        setToken(data.session?.access_token ?? null);
      } catch {
        /* no session available — sessionChecked below still gates the identity step */
      } finally {
        if (mountedRef.current) setSessionChecked(true);
      }
      // A leftover draft id can point at a PREVIOUS, already-completed submission (the officer
      // finished citizen X and reopened this page for citizen Y without a reload). Reusing it
      // would let Y's answers overwrite X's draft, union Y's photos into X's rollup, and collide
      // on X's offline_id server-side (ON CONFLICT DO NOTHING silently drops Y's case) — P1.
      // Detect "already submitted" (canonical_id assigned, or marked synced) and start fresh
      // instead. An in-progress draft (mid-flow reload) is still re-hydrated as before.
      const draftId = getDraftId();
      if (draftId) {
        try {
          const draft = await getCase(draftId);
          if (!mountedRef.current) return;
          if (draft) {
            const isCompleted =
              draft.sync_status === "synced" || typeof draft.canonical_id === "string";
            if (isCompleted) {
              clearDraftId();
              clearOfficerPocMask();
            } else if (classIdsRef.current.length === 0) {
              classIdsRef.current = classIdsFromCaseCategory(draft.case_category);
            }
          }
        } catch {
          /* fresh draft — start empty */
        }
      }
    })();
    return () => {
      mountedRef.current = false;
      // Revoke every object URL the strip created — without this each capture leaks a blob for
      // the lifetime of the document.
      try {
        thumbnailsRef.current.forEach((url) => URL.revokeObjectURL(url));
      } catch {
        /* nothing to revoke / API unavailable */
      }
      thumbnailsRef.current = [];
    };
  }, []);

  // ---- Identity ----------------------------------------------------------
  async function handleIdentityNext() {
    // P2: never persist submitted_by_officer=true with a null officer_id — the backend would
    // later reject the submission with 403 (officer_id mismatch), losing the officer's work
    // deep into the flow. Block here instead, while it's still recoverable via re-login.
    if (!sessionChecked || !officerId) {
      setIdentityError(t("submit.sessionError"));
      return;
    }
    const nicErr = isValidNIC(nic) ? null : t("submit.nicError");
    const mobErr = isValidMobile(mobile) ? null : t("submit.mobileError");
    setNicError(nicErr);
    setMobileError(mobErr);
    if (nicErr || mobErr || saving) return;

    setSaving(true);
    setIdentityError(null);
    try {
      // FR-10.3 gate on the officer-assisted path (Story 8.5). The officer is standing with the
      // citizen and their card; resolving the household HERE means an unregistered family is
      // found out in the first seconds, not after the officer has photographed the damage and
      // walked away. The backend would refuse that submission with 403 not_registered.
      //
      // The officer app cannot derive the reference itself: it encrypts the NIC with a
      // non-extractable device key, so only the server can match it to a household.
      const lookup = await lookupHousehold(nic.trim());
      if (!mountedRef.current) return;
      if (lookup.status === "not-registered") {
        setIdentityError(t("submit.householdNotRegistered"));
        setSaving(false);
        return;
      }
      if (lookup.status === "error") {
        // Deliberately NOT reported as "not registered": on a network blip that would send a
        // properly registered family to the DS office to fix nothing.
        setIdentityError(t("submit.householdLookupFailed"));
        setSaving(false);
        return;
      }

      const key = await getOrCreateSessionKey();
      const nicEnc = await encryptField(nic.trim(), key);
      const mobileEnc = await encryptField(mobile.trim(), key);
      if (!mountedRef.current) return;

      const draftId = getOrCreateDraftId();
      await updateDraft(draftId, {
        // The reference, not the NIC — this is what travels to the submit endpoint. The NIC
        // itself stays encrypted, exactly as before.
        household_ref: lookup.household.household_ref,
        reporter_nic_ciphertext: nicEnc.ciphertext,
        reporter_nic_iv: nicEnc.iv,
        reporter_mobile_ciphertext: mobileEnc.ciphertext,
        reporter_mobile_iv: mobileEnc.iv,
        submitted_by_officer: true,
        officer_id: officerId,
      });
      if (!mountedRef.current) return;
      setStep("location");
      void beginLocationDetect();
    } catch {
      if (mountedRef.current) setIdentityError(t("submit.identitySaveError"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  // ---- Location ----------------------------------------------------------
  function beginLocationDetect() {
    setLocStatus("detecting");
    getCurrentPosition()
      .then((c) => {
        if (!mountedRef.current) return;
        setCoords({ lat: c.latitude, lng: c.longitude });
        setLocStatus("gps");
      })
      .catch(() => {
        if (mountedRef.current) setLocStatus("manual");
      });
  }

  async function saveLocation(loc: LatLng, source: "gps" | "manual") {
    if (saving) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const draftId = getOrCreateDraftId();
      await updateDraft(draftId, {
        location_lat: loc.lat,
        location_lng: loc.lng,
        location_source: source,
        district: district?.district,
        ds_division: district?.dsDivision,
      });
      if (mountedRef.current) setStep("damage");
    } catch {
      if (mountedRef.current) setSubmitError(t("submit.locationSaveError"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  // ---- Damage ------------------------------------------------------------
  async function handleDamageNext() {
    if (!damage) {
      setDamageError(t("submit.damageRequired"));
      return;
    }
    if (saving) return;
    setSaving(true);
    setDamageError(null);
    try {
      const draftId = getOrCreateDraftId();
      await updateDraft(draftId, { damage_category: damage });
      if (mountedRef.current) setStep("classify");
    } catch {
      if (mountedRef.current) setDamageError(t("submit.damageSaveError"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  // ---- Classify (3.3) ----------------------------------------------------
  // Receives a still from the in-app shutter or a file from the gallery fallback — both arrive
  // as a File, so the pipeline below is identical for either route.
  async function handleCapture(file: File) {
    if (inFlightRef.current) return;
    // Hard cap (mockup's "N of 10"): the shutter and gallery button are already disabled at the
    // cap, so reaching here means a race — drop it silently rather than erroring.
    if (thumbnailsRef.current.length >= MAX_PHOTOS) return;
    inFlightRef.current = true;

    setClassifyStatus("classifying");
    setQualityWarning(false);
    setDecision(null);

    try {
      try {
        const quality = await assessImageQuality(file);
        if (!mountedRef.current) return;
        if (quality.blurry || quality.poorExposure) setQualityWarning(true);
      } catch {
        if (mountedRef.current) setClassifyStatus("error");
        return;
      }

      const classification = await classifyImage(file);
      if (!mountedRef.current) return;

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
      setClassifyStatus("result");
    } catch {
      if (mountedRef.current) setClassifyStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleOverrideConfirm(category: ClassId, reason: string) {
    if (!result) return;
    if (overrideSavingRef.current) return;
    overrideSavingRef.current = true;
    setOverrideError(false);
    const draftId = getOrCreateDraftId();
    const nextClassIds = [...classIdsRef.current];
    if (nextClassIds.length > 0) {
      nextClassIds[nextClassIds.length - 1] = category;
    } else {
      nextClassIds.push(category);
    }
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
      if (mountedRef.current) setOverrideError(true);
      return;
    } finally {
      overrideSavingRef.current = false;
    }
    classIdsRef.current = nextClassIds;
    if (!mountedRef.current) return;
    setDecision("overridden");
  }

  // ---- Submit ------------------------------------------------------------
  async function handleSubmit() {
    if (saving) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const draftId = getOrCreateDraftId();
      const draft = (await getCase(draftId)) ?? { offline_id: draftId };
      // Build the PoC (offline-first): generates offline_id/timestamp + identity hash and
      // persists the receipt fields with sync_status "pending".
      const poc = await buildPoC(draft);
      const record = { ...poc, submitted_by_officer: true, officer_id: officerId ?? undefined };

      // Carry only the LAST 4 of the citizen NIC (already masked) via sessionStorage so the
      // PoC screen can display the mask — full plaintext is never persisted (NFR-3.1).
      try {
        sessionStorage.setItem(OFFICER_POC_NIC_KEY, nic.trim().slice(-4));
      } catch {
        /* storage blocked — the badge simply omits the mask */
      }

      // Best-effort online submit — the receipt renders regardless of the outcome (CRITICAL #3).
      if (token) {
        const submitResult = await submitCaseOnline(record, token);
        if (submitResult) {
          await updateDraft(draftId, {
            canonical_id: submitResult.canonical_id,
            sync_status: "synced",
          }).catch(() => {});
        }
      }
      if (!mountedRef.current) return;
      router.push("/officer/submit/poc");
    } catch {
      if (mountedRef.current) setSubmitError(t("submit.submitError"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  const stepTitles: Record<Step, string> = {
    identity: t("submit.step1"),
    location: t("submit.step2"),
    damage: t("submit.step3"),
    classify: t("submit.step4"),
    review: t("submit.step5"),
  };

  return (
    // No horizontal padding on <main>: the top bar and (on the classify step) the camera
    // viewport are full-bleed in the mockup. Only the form panel below them is inset.
    <main className="flex-1 bg-surface-base">
      <div className="mx-auto w-full max-w-md">
        {/* Mockup's step bar: the label carries the progress in words, the dots mirror it. */}
        <OfficerTopBar
          label={stepTitles[step]}
          totalSteps={STEP_ORDER.length}
          currentStep={STEP_ORDER.indexOf(step)}
        />

        {/* Camera is full-bleed and sits directly under the step bar, as in the mockup — so it
            renders outside the padded panel that holds every other step's controls. */}
        {step === "classify" && (
          <>
            <CameraCapture
              onCapture={(file) => void handleCapture(file)}
              disabled={classifyStatus === "classifying"}
              busyLabel={t("classify.analyzing")}
              atMax={thumbnails.length >= MAX_PHOTOS}
              thumbnails={thumbnails}
              onBack={() => setStep("damage")}
              fileInputTestId="submit-file-input"
            />
            <div className="border-b border-border-default bg-surface-raised px-design-5 py-design-3 text-center">
              <p className="text-label text-ink-secondary">
                <span aria-hidden="true">📸 </span>
                {thumbnails.length >= MAX_PHOTOS
                  ? t("camera.maxReached", { max: MAX_PHOTOS })
                  : t("camera.instruction")}
              </p>
              <p className="text-caption text-ink-disabled">
                {t("camera.count", { count: thumbnails.length, max: MAX_PHOTOS })}
              </p>
            </div>
          </>
        )}

        <div className="space-y-design-4 px-design-4 py-design-5">
          {step === "identity" && (
            <form
            className="space-y-design-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleIdentityNext();
            }}
          >
            <p className="text-label text-ink-secondary">
              {t.rich("submit.identityHint", { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <div className="flex flex-col gap-design-2">
              <label htmlFor="citizen-nic" className="text-label font-medium text-ink-primary">
                {t("submit.citizenNic")}
              </label>
              <input
                id="citizen-nic"
                type="text"
                autoComplete="off"
                placeholder={t("submit.nicPlaceholder")}
                value={nic}
                onChange={(e) => setNic(e.target.value)}
                aria-invalid={!!nicError}
                className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
              />
              {nicError && (
                <p role="alert" className="text-caption text-status-error">
                  {nicError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-design-2">
              <label htmlFor="citizen-mobile" className="text-label font-medium text-ink-primary">
                {t("submit.citizenMobile")}
              </label>
              <input
                id="citizen-mobile"
                type="tel"
                inputMode="numeric"
                placeholder={t("submit.mobilePlaceholder")}
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                aria-invalid={!!mobileError}
                className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
              />
              {mobileError && (
                <p role="alert" className="text-caption text-status-error">
                  {mobileError}
                </p>
              )}
            </div>
            {sessionChecked && !officerId && (
              <p role="alert" className="text-caption text-status-error">
                {t("submit.sessionError")}
              </p>
            )}
            {identityError && (
              <p role="alert" className="text-caption text-status-error">
                {identityError}
              </p>
            )}
            <button
              type="submit"
              disabled={saving || !sessionChecked || !officerId}
              className="w-full min-h-primary-btn bg-amber text-ink-on-amber text-headline font-semibold rounded-md disabled:opacity-60"
            >
              {sessionChecked ? t("submit.continue") : t("submit.verifyingSession")}
            </button>
          </form>
        )}

        {step === "location" && (
          <div className="space-y-design-4">
            <DistrictPicker
              value={district}
              onChange={setDistrict}
              districtLabel={t("submit.districtLabel")}
              districtPlaceholder={t("submit.districtPlaceholder")}
              dsDivisionLabel={t("submit.dsDivisionLabel")}
              dsDivisionPlaceholder={t("submit.dsDivisionPlaceholder")}
            />
            {locStatus === "detecting" && (
              <div className="flex flex-col items-center gap-design-3 py-design-7" role="status" aria-live="polite">
                <span className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest" aria-hidden="true" />
                <p className="text-body text-ink-secondary">{t("submit.detectingGps")}</p>
              </div>
            )}
            {locStatus === "gps" && coords && (
              <div className="space-y-design-4">
                <div className="rounded-md border border-status-success bg-surface-tint p-design-4">
                  <p className="text-label font-semibold text-status-success">{t("submit.gpsDetected")}</p>
                  <p className="text-body text-ink-primary">
                    {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveLocation(coords, "gps")}
                  className="w-full min-h-primary-btn bg-amber text-ink-on-amber text-headline font-semibold rounded-md disabled:opacity-60"
                >
                  {t("submit.continue")}
                </button>
              </div>
            )}
            {locStatus === "manual" && (
              <div className="space-y-design-3">
                <p className="text-body text-ink-secondary">{t("submit.gpsFailed")}</p>
                <MapPinPicker
                  initial={coords ?? SRI_LANKA_CENTER}
                  confirmLabel={t("submit.confirmLocation")}
                  onConfirm={(c) => void saveLocation(c, "manual")}
                />
              </div>
            )}
            {submitError && (
              <p role="alert" className="text-caption text-status-error">
                {submitError}
              </p>
            )}
          </div>
        )}

        {step === "damage" && (
          <div className="space-y-design-4">
            <div role="radiogroup" aria-label={t("submit.damageCategoryGroup")} className="grid grid-cols-2 gap-design-3">
              {DAMAGE_CATEGORIES.map((cat) => (
                <DamageCard
                  key={cat}
                  category={cat}
                  label={tReport(`step3.${cat}`)}
                  selected={damage === cat}
                  onSelect={() => {
                    setDamage(cat);
                    setDamageError(null);
                  }}
                />
              ))}
            </div>
            {damageError && (
              <p role="alert" className="text-caption text-status-error">
                {damageError}
              </p>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleDamageNext()}
              className="w-full min-h-primary-btn bg-amber text-ink-on-amber text-headline font-semibold rounded-md disabled:opacity-60"
            >
              {t("submit.continue")}
            </button>
          </div>
        )}

        {step === "classify" && (
          <div className="space-y-design-4">
            {qualityWarning && (
              <p role="alert" className="text-caption text-status-warning">
                {t("classify.qualityWarning")}
              </p>
            )}
            {classifyStatus === "error" && (
              <p role="alert" className="text-caption text-status-error">
                {t("classify.classifyError")}
              </p>
            )}

            {/* Mockup screen 2: the photos banked so far, with the current subject ringed. */}
            <PhotoStrip
              thumbnails={thumbnails}
              countLabel={t("classify.photosCaptured", { count: thumbnails.length })}
              ariaLabel={t("classify.photoStripAria")}
            />

            {classifyStatus === "result" && result && (
              <>
                <AIResultCard
                  classId={result.classId}
                  severity={result.severity}
                  confidence={result.confidence}
                  processingTimeMs={result.processingTimeMs}
                  modelVersion={result.modelVersion}
                  onAccept={() => {
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

                {/* Mockup places the note between the result card and the forward CTA. Mirrored
                    into `fieldNotes` so the review step can show what will be kept with the case. */}
                <FieldNotes onSaved={setFieldNotes} />

                {(decision === "accepted" || decision === "overridden") && (
                  <button
                    type="button"
                    onClick={() => setStep("review")}
                    className="w-full min-h-primary-btn bg-amber text-ink-on-amber text-headline font-semibold rounded-md"
                  >
                    {t("submit.reviewAndSubmit")}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {step === "review" && (
          <div className="space-y-design-4">
            <dl className="space-y-design-2 rounded-md border border-border-default bg-surface-raised p-design-4">
              <div className="flex justify-between gap-design-3">
                <dt className="text-label text-ink-secondary">{t("submit.reviewDamage")}</dt>
                <dd className="text-label text-ink-primary">{damage ? tReport(`step3.${damage}`) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-design-3">
                <dt className="text-label text-ink-secondary">{t("submit.reviewAi")}</dt>
                <dd className="text-label text-ink-primary">
                  {result ? t(`aiResult.${result.classId}`) : "—"}
                  {decision === "overridden" ? t("submit.reviewOverridden") : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-design-3">
                <dt className="text-label text-ink-secondary">{t("submit.reviewLocation")}</dt>
                <dd className="text-label text-ink-primary">
                  {coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-design-3">
                <dt className="text-label text-ink-secondary">{t("submit.reviewOfficer")}</dt>
                <dd className="text-label text-ink-primary break-all">{officerId ?? "—"}</dd>
              </div>
              {/* Only shown once there is a note — an empty row would imply the officer had
                  missed a required field. */}
              {fieldNotes.trim() && (
                <div className="flex flex-col gap-design-1 border-t border-border-default pt-design-2">
                  <dt className="text-label text-ink-secondary">{t("submit.reviewNotes")}</dt>
                  <dd className="text-label leading-relaxed text-ink-primary">{fieldNotes}</dd>
                </div>
              )}
            </dl>
            {submitError && (
              <p role="alert" className="text-caption text-status-error">
                {submitError}
              </p>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSubmit()}
              className="w-full min-h-primary-btn bg-forest text-ink-on-dark text-headline font-semibold rounded-md disabled:opacity-60"
            >
              {saving ? t("submit.submitting") : t("submit.submit")}
            </button>
          </div>
        )}
        </div>
      </div>
    </main>
  );
}
