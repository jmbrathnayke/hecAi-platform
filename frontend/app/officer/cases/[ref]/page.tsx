"use client";
// Officer case review (final governance workflow). Where a "new report in your division"
// notification lands: the protected, officer-scoped view of ONE citizen case, not the public status
// page.
//
// THE FAMILY'S REPORT COMES FIRST, AND STAYS VISIBLE. Their description and photographs are shown
// for every case the officer can open, whatever its status. They used to sit inside the assessment
// box, so they vanished the moment a case was approved -- and an officer asked about a case later
// could no longer see what had been reported.
//
// THE ASSESSMENT IS THE OFFICER'S. MobileNetV2 classifies on this device (lib/mobilenet.ts), from
// one of two inputs, and the record says which:
//   * one of the family's own photographs -- downloaded into this browser and classified here, so a
//     report can be assessed before anyone travels to it; or
//   * the officer's own photo of the site, which is then attached to the case as evidence.
// No image is ever sent anywhere TO BE CLASSIFIED. The officer accepts or overrides the result
// before it is recorded (NFR-6.1), and the resulting compensation figure is shown as an AI-assisted
// estimate: the DWC administrator reviews it and the Divisional Secretariat decides the final amount.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { OfficerTopBar } from "@/components/OfficerTopBar";
import { CameraCapture } from "@/components/CameraCapture";
import { AIResultCard } from "@/components/AIResultCard";
import { OverrideForm } from "@/components/OverrideForm";
import { assessImageQuality } from "@/lib/imageQuality";
import { classifyImage, type ClassId, type ClassificationResult } from "@/lib/mobilenet";
import { isKnownStage, isTranslatedStatus, statusKey } from "@/lib/status";
import CropAssessmentFields from "@/components/CropAssessmentFields";
import { PhotoGallery } from "@/components/admin/PhotoGallery";
import { ClaimantDetails } from "@/components/ClaimantDetails";
import { uploadCasePhoto, type CasePhoto } from "@/lib/casePhotos";
import {
  buildAssessmentBody,
  type AssessmentInput,
  EMPTY_CROP_ASSESSMENT,
  getOfficerCase,
  isDeliveryEvent,
  isWorkflowEvent,
  parseCropAssessment,
  startOfficerReview,
  submitOfficerAssessment,
  type CropAssessment,
  type OfficerCaseDetail,
  type OverrideChoice,
  type ReviewFailure,
} from "@/lib/officerCaseReview";

type Load = { kind: "loading" } | { kind: "ready"; detail: OfficerCaseDetail } | { kind: "failed"; failure: ReviewFailure };
type Capture = "idle" | "classifying" | "result" | "error";

function failureKey(f: ReviewFailure): string {
  switch (f.reason) {
    case "no-session":
    case "signed-out":
      return "caseReview.error.signedOut";
    case "forbidden":
      return "caseReview.error.forbidden";
    case "not-found":
      return "caseReview.error.notFound";
    case "closed":
      return "caseReview.error.closed";
    case "invalid":
      return "caseReview.error.invalid";
    case "network":
      return "caseReview.error.network";
    default:
      return "caseReview.error.server";
  }
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale);
}

export default function OfficerCaseReviewPage() {
  const t = useTranslations("officer");
  const tStatus = useTranslations("status");
  const locale = useLocale();
  const params = useParams<{ ref: string }>();
  const ref = decodeURIComponent(String(params?.ref ?? "")).toUpperCase();

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [actionError, setActionError] = useState<ReviewFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [capture, setCapture] = useState<Capture>("idle");
  const [qualityWarning, setQualityWarning] = useState(false);
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [decision, setDecision] = useState<"accepted" | "override" | "overridden" | null>(null);
  const [crop, setCrop] = useState<CropAssessment>(EMPTY_CROP_ASSESSMENT);
  const [override, setOverride] = useState<OverrideChoice | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  // The exact file MobileNetV2 classified, held so it can be attached to the case once the
  // assessment is accepted. Until now it was used for a thumbnail and then dropped, which is why
  // the administrator approving this case could never see what the officer had photographed.
  const capturedRef = useRef<File | null>(null);
  const [photoNotice, setPhotoNotice] = useState<"uploading" | "uploaded" | "failed" | null>(null);
  // What the result on screen was classified from. The family's photo is already on the server,
  // so only the officer's own capture is uploaded after the assessment is recorded.
  const [input, setInput] = useState<AssessmentInput>({ kind: "camera" });
  const [photoFetchFailed, setPhotoFetchFailed] = useState(false);
  const assessmentRef = useRef<HTMLElement | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    setLoad({ kind: "loading" });
    const res = await getOfficerCase(ref);
    if (!mountedRef.current) return;
    setLoad(res.ok ? { kind: "ready", detail: res.detail } : { kind: "failed", failure: res.failure });
  }, [ref]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  useEffect(
    () => () => {
      try {
        thumbnails.forEach((u) => URL.revokeObjectURL(u));
      } catch {
        /* nothing to revoke */
      }
    },
    // Revoke on unmount only; each capture replaces the single thumbnail below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function handleStartReview() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const res = await startOfficerReview(ref);
    if (!mountedRef.current) return;
    setBusy(false);
    if (res.ok) {
      setLoad({ kind: "ready", detail: res.detail });
      setNotice(t("caseReview.reviewStarted"));
    } else {
      setActionError(res.failure);
    }
  }

  // One classification path for both inputs, so the family's photo is quality-checked and
  // classified exactly as the officer's own capture is.
  async function classify(image: Blob, source: AssessmentInput) {
    setCapture("classifying");
    setQualityWarning(false);
    setDecision(null);
    setOverride(null);
    setInput(source);
    try {
      try {
        const quality = await assessImageQuality(image);
        if (quality.blurry || quality.poorExposure) setQualityWarning(true);
      } catch {
        if (mountedRef.current) setCapture("error");
        return;
      }
      const classification = await classifyImage(image);
      if (!mountedRef.current) return;
      // Only the officer's own capture is attached to the case afterwards. The family's photograph
      // is already stored; uploading it again would duplicate it under the officer's label.
      capturedRef.current = source.kind === "camera" && image instanceof File ? image : null;
      try {
        const url = URL.createObjectURL(image);
        setThumbnails((prev) => {
          prev.forEach((u) => URL.revokeObjectURL(u));
          return [url];
        });
      } catch {
        /* thumbnail is decoration */
      }
      setResult(classification);
      setCapture("result");
    } catch {
      if (mountedRef.current) setCapture("error");
    }
  }

  async function handleCapture(file: File) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhotoFetchFailed(false);
    try {
      await classify(file, { kind: "camera" });
    } finally {
      inFlightRef.current = false;
    }
  }

  // The family's photograph, classified on this device. It is fetched through the signed URL the
  // gallery already holds (Supabase Storage allows cross-origin reads), so nothing about it is
  // sent anywhere to be classified.
  async function handleClassifyCitizenPhoto(photo: CasePhoto) {
    if (inFlightRef.current || !photo.url) return;
    inFlightRef.current = true;
    setPhotoFetchFailed(false);
    assessmentRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    try {
      let image: Blob;
      try {
        const res = await fetch(photo.url);
        if (!res.ok) throw new Error(`photo fetch ${res.status}`);
        image = await res.blob();
      } catch {
        // A signed URL lasts ten minutes, so a gallery left open longer fails here; the message
        // tells the officer to reload, which issues fresh ones.
        if (mountedRef.current) {
          setPhotoFetchFailed(true);
          setCapture("idle");
        }
        return;
      }
      if (!mountedRef.current) return;
      await classify(image, { kind: "citizen_photo", photoId: photo.id });
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleSubmitAssessment() {
    if (!result || busy || decision === null || decision === "override") return;
    setBusy(true);
    setActionError(null);
    const res = await submitOfficerAssessment(ref, buildAssessmentBody(result, override, crop, input));
    if (!mountedRef.current) return;
    setBusy(false);
    if (res.ok) {
      setLoad({ kind: "ready", detail: res.detail });
      setNotice(t("caseReview.assessmentRecorded"));
      // Attach the photograph AFTER the assessment is recorded, never before: the classification
      // is what the workflow depends on, and a failed upload must not cost the officer their
      // assessment. A failure here is reported rather than swallowed -- silently losing the
      // evidence is what this whole change exists to stop.
      const file = capturedRef.current;
      if (file) {
        setPhotoNotice("uploading");
        const up = await uploadCasePhoto(ref, file);
        if (mountedRef.current) setPhotoNotice(up.ok ? "uploaded" : "failed");
        if (up.ok) capturedRef.current = null;
      }
      setResult(null);
      setDecision(null);
      setOverride(null);
      setCrop(EMPTY_CROP_ASSESSMENT);
      setInput({ kind: "camera" });
      setCapture("idle");
    } else {
      // The classification stays on screen so the officer can retry without re-photographing.
      setActionError(res.failure);
    }
  }

  if (load.kind === "loading") {
    return (
      <main className="flex-1 bg-surface-base">
        <OfficerTopBar label={t("caseReview.title")} />
        <p role="status" className="px-design-4 py-design-5 text-body text-ink-secondary">
          {t("caseReview.loading")}
        </p>
      </main>
    );
  }

  if (load.kind === "failed") {
    const signIn = load.failure.reason === "no-session" || load.failure.reason === "signed-out";
    return (
      <main className="flex-1 bg-surface-base">
        <OfficerTopBar label={t("caseReview.title")} />
        <div role="alert" className="mx-auto max-w-2xl space-y-design-3 px-design-4 py-design-5">
          <p className="text-body text-status-error">{t(failureKey(load.failure))}</p>
          {signIn ? (
            <Link href="/officer/login" className="inline-flex min-h-touch-target items-center rounded-md border border-forest px-design-4 text-label font-semibold text-forest">
              {t("dashboard.error.signIn")}
            </Link>
          ) : (
            <button type="button" onClick={() => void reload()} className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest">
              {t("dashboard.retry")}
            </button>
          )}
          <Link href="/officer/dashboard" className="block text-label font-semibold text-forest underline">
            {t("caseReview.back")}
          </Link>
        </div>
      </main>
    );
  }

  const { detail } = load;
  const c = detail.case;
  const wf = detail.workflow;
  const stageLabel = isKnownStage(wf.stage) ? tStatus(`stageLabels.${wf.stage}`) : wf.stage;
  const statusLabel = isTranslatedStatus(c.status) ? tStatus(`statusLabels.${statusKey(c.status)}`) : c.status;
  const history = detail.history.filter((h) => !isDeliveryEvent(h.event));
  // The class the estimate will actually be priced against: the officer's override when they
  // corrected the model, otherwise the model's own prediction. Only settled once they have
  // accepted or confirmed an override, so the crop question is never asked about a class still
  // under consideration.
  const settledClass: ClassId | null =
    decision === "overridden" && override ? override.category
    : decision === "accepted" && result ? result.classId
    : null;

  // A crop assessment cannot be submitted without the crop, the area and the extent. The server
  // refuses it too (400 crop_type_required); blocking here is so the officer is told before losing
  // a round trip, not instead of the server check.
  const cropReady = settledClass !== "crop_damage" || parseCropAssessment(crop) !== null;
  const canSubmit =
    result !== null && (decision === "accepted" || decision === "overridden") && cropReady && !busy;

  return (
    <main className="flex-1 bg-surface-base">
      <OfficerTopBar
        label={t("caseReview.title")}
        action={
          <Link href="/officer/dashboard" className="shrink-0 text-label font-semibold text-forest">
            {t("caseReview.back")}
          </Link>
        }
      />

      <div className="mx-auto max-w-2xl space-y-design-4 px-design-4 py-design-5">
        {notice && (
          <p role="status" className="rounded-md bg-forest-pale px-design-4 py-design-3 text-label text-forest">
            {notice}
          </p>
        )}
        {/* Said separately from the assessment notice because they can differ: the classification
            can be recorded while the photograph is still uploading, or fails to. */}
        {photoNotice && (
          <p
            role="status"
            data-testid="photo-upload-notice"
            className={`rounded-md px-design-4 py-design-3 text-label ${
              photoNotice === "failed" ? "bg-amber-pale text-amber" : "bg-forest-pale text-forest"
            }`}
          >
            {t(`photo.${photoNotice === "failed" ? "uploadFailed" : photoNotice === "uploading" ? "uploading" : "uploaded"}`)}
          </p>
        )}
        {actionError && (
          <p role="alert" className="rounded-md border border-status-error px-design-4 py-design-3 text-body text-status-error">
            {t(failureKey(actionError))}
          </p>
        )}

        {/* ------------------------------------------------------------ the case */}
        <section className="rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card" data-testid="case-details">
          <div className="flex items-center justify-between gap-design-2">
            <h1 className="font-mono text-headline text-ink-primary">{c.canonical_id}</h1>
            <span className="rounded-full bg-surface-base px-design-2 text-caption font-medium text-ink-secondary">{statusLabel}</span>
          </div>
          <p className="mt-design-1 text-caption text-ink-secondary">
            {t("caseReview.stage")}: <span className="font-semibold text-ink-primary">{stageLabel}</span>
          </p>
          <dl className="mt-design-3 grid grid-cols-1 gap-design-2 text-body sm:grid-cols-2">
            <Field label={t("caseReview.household")} value={c.household_ref} />
            <Field label={t("caseReview.damage")} value={c.damage_category} />
            <Field label={t("caseReview.district")} value={c.district} />
            <Field label={t("caseReview.division")} value={c.ds_division} />
            <Field label={t("caseReview.submitted")} value={formatDateTime(c.submitted_at, locale)} />
            <Field label={t("caseReview.channel")} value={c.submitted_by_officer ? t("caseReview.channelOfficer") : t("caseReview.channelCitizen")} />
            <Field
              label={t("caseReview.location")}
              value={c.gps_lat !== null && c.gps_lng !== null ? `${c.gps_lat.toFixed(5)}, ${c.gps_lng.toFixed(5)}` : null}
            />
            <Field
              label={t("caseReview.assignment")}
              value={wf.assigned_officer_id ? (wf.assigned_to_me ? t("caseReview.assignedToMe") : t("caseReview.assignedToOther")) : t("caseReview.unassigned")}
            />
          </dl>
        </section>

        {/* ------------------------------------------------------------ who submitted it */}
        {/* The registered household behind the claim: who to call and where to go before the site
            visit. Fetched for this one case only, and the read is audited server-side. */}
        <ClaimantDetails caseRef={c.canonical_id ?? ref} />

        {/* ------------------------------------------------------------ the family's report */}
        {/* Always shown, whatever the case's status: what the family wrote and photographed is the
            claim itself, and the officer must be able to read it before, during and after their
            own assessment. */}
        <section
          className="space-y-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4"
          data-testid="citizen-report"
        >
          <h2 className="text-headline text-ink-primary">{t("caseReview.citizenReportTitle")}</h2>
          <div>
            <h3 className="text-label font-semibold text-ink-primary">{t("caseReview.citizenDescription")}</h3>
            {c.citizen_description ? (
              <p className="mt-design-1 whitespace-pre-wrap text-body text-ink-primary" data-testid="citizen-description">
                {c.citizen_description}
              </p>
            ) : (
              <p className="mt-design-1 text-body text-ink-secondary" data-testid="citizen-description-none">
                {t("caseReview.noCitizenDescription")}
              </p>
            )}
          </div>
          <PhotoGallery
            caseRef={ref}
            variant="officer"
            onClassify={detail.actions.can_assess ? (photo) => void handleClassifyCitizenPhoto(photo) : undefined}
            activePhotoId={input.kind === "citizen_photo" && capture !== "idle" ? input.photoId : null}
            classifyDisabled={capture === "classifying" || busy}
          />
          {detail.actions.can_assess && (
            <p className="text-caption text-ink-secondary">{t("caseReview.classifyCitizenHint")}</p>
          )}
        </section>

        {detail.actions.can_start_review && (
          <button
            type="button"
            onClick={() => void handleStartReview()}
            disabled={busy}
            className="flex min-h-primary-btn w-full items-center justify-center rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber disabled:opacity-60"
          >
            {t("caseReview.startReview")}
          </button>
        )}

        {/* ------------------------------------------------------------ officer assessment */}
        {detail.actions.can_assess && (
          <section
            ref={assessmentRef}
            className="space-y-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4"
            data-testid="officer-assessment"
          >
            <h2 className="text-headline text-ink-primary">
              {detail.actions.already_assessed ? t("caseReview.reassessTitle") : t("caseReview.assessTitle")}
            </h2>
            <p className="text-caption text-ink-secondary">{t("caseReview.assessHint")}</p>

            <CameraCapture
              onCapture={(file) => void handleCapture(file)}
              disabled={capture === "classifying" || busy}
              busyLabel={t("classify.analyzing")}
              atMax={false}
              thumbnails={input.kind === "camera" ? thumbnails : []}
              fileInputTestId="case-review-file-input"
            />

            {photoFetchFailed && (
              <p role="alert" className="text-caption text-status-error" data-testid="citizen-photo-fetch-failed">
                {t("classify.photoFetchError")}
              </p>
            )}
            {qualityWarning && <p role="alert" className="text-caption text-status-warning">{t("classify.qualityWarning")}</p>}
            {capture === "error" && <p role="alert" className="text-caption text-status-error">{t("classify.classifyError")}</p>}
            {capture === "classifying" && input.kind === "citizen_photo" && (
              <p role="status" className="text-caption text-ink-secondary">{t("classify.analyzingCitizenPhoto")}</p>
            )}

            {capture === "result" && result && (
              <>
                {/* Said above the result, because it changes what the result is evidence of: the
                    family's own photograph rather than what the officer saw at the site. */}
                {input.kind === "citizen_photo" && (
                  <div
                    className="flex items-center gap-design-3 rounded-md bg-forest-pale p-design-2"
                    data-testid="classified-from-citizen"
                  >
                    {thumbnails[0] && (
                      // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL
                      <img src={thumbnails[0]} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
                    )}
                    <p className="text-caption text-forest">{t("caseReview.resultFromCitizenPhoto")}</p>
                  </div>
                )}
                <AIResultCard
                  classId={result.classId}
                  severity={result.severity}
                  confidence={result.confidence}
                  processingTimeMs={result.processingTimeMs}
                  modelVersion={result.modelVersion}
                  outOfDomain={result.outOfDomain}
                  onAccept={() => {
                    setOverride(null);
                    setDecision("accepted");
                  }}
                  onOverride={() => setDecision("override")}
                />
                {decision === "override" && (
                  <OverrideForm
                    currentCategory={result.classId}
                    onConfirm={(category: ClassId, reason: string) => {
                      setOverride({ category, reason });
                      setDecision("overridden");
                    }}
                    onCancel={() => setDecision(null)}
                  />
                )}
                {decision === "accepted" && <p className="text-label text-status-success">{t("classify.accepted")}</p>}
                {decision === "overridden" && <p className="text-label text-status-success">{t("classify.overridden")}</p>}
                {/* Crop damage needs the crop, which no classifier can supply. Shown once the class
                    is settled — accepted or overridden — so the question is only ever asked about a
                    class the officer has actually committed to. */}
                {settledClass === "crop_damage" && (
                  <CropAssessmentFields value={crop} onChange={setCrop} disabled={busy} />
                )}
                <p className="text-caption text-ink-secondary">{t("caseReview.notFinalClassification")}</p>
                <button
                  type="button"
                  onClick={() => void handleSubmitAssessment()}
                  disabled={!canSubmit}
                  className="flex min-h-primary-btn w-full items-center justify-center rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-60"
                >
                  {busy ? t("caseReview.submitting") : t("caseReview.submitAssessment")}
                </button>
              </>
            )}
          </section>
        )}

        {/* ------------------------------------------------------------ recorded AI result */}
        <section className="rounded-md border border-border-subtle bg-surface-raised p-design-4" data-testid="recorded-ai-result">
          <h2 className="text-headline text-ink-primary">{t("caseReview.aiResultTitle")}</h2>
          {detail.ai_result ? (
            <dl className="mt-design-2 grid grid-cols-1 gap-design-2 text-body sm:grid-cols-2">
              <Field label={t("caseReview.prediction")} value={labelFor(t, detail.ai_result.prediction)} />
              <Field
                label={t("aiResult.confidence")}
                value={detail.ai_result.confidence !== null ? `${Math.round(detail.ai_result.confidence * 100)}%` : null}
              />
              <Field label={t("caseReview.severity")} value={detail.ai_result.ai_severity ? t(`severity.${detail.ai_result.ai_severity}`) : null} />
              <Field
                label={t("caseReview.officerDecision")}
                value={detail.ai_result.was_overridden ? `${t("classify.overridden")} → ${labelFor(t, detail.ai_result.override_category)}` : t("classify.accepted")}
              />
              {(detail.ai_result.input_source === "citizen_photo" || detail.ai_result.input_source === "officer_capture") && (
                <Field
                  label={t("caseReview.classifiedFrom")}
                  value={t(`caseReview.inputSource.${detail.ai_result.input_source}`)}
                />
              )}
            </dl>
          ) : (
            <p className="mt-design-2 text-body text-ink-secondary">{t("caseReview.noAiResult")}</p>
          )}
          {/* A gated row reads "No Damage" like any other. Left unexplained, the officer takes it
              as a finding about the land instead of what it is: the model recognised nothing in
              the photograph at all. */}
          {detail.ai_result?.out_of_domain && (
            <p
              data-testid="recorded-ood-notice"
              className="mt-design-2 rounded-md border border-amber bg-amber-pale p-design-3 text-caption leading-relaxed text-ink-primary"
            >
              {t("aiResult.outOfDomainNotice")}
            </p>
          )}
          <p className="mt-design-2 text-caption text-ink-secondary">{t("caseReview.notFinalClassification")}</p>
        </section>

        {/* ------------------------------------------------------------ AI-assisted estimate */}
        <section className="rounded-md border border-status-warning bg-surface-raised p-design-4" data-testid="ai-assisted-estimate">
          <h2 className="text-headline text-ink-primary">{t("caseReview.estimateTitle")}</h2>
          {detail.ai_assisted_estimate ? (
            <>
              <p className="mt-design-2 text-title text-ink-primary">
                LKR {detail.ai_assisted_estimate.amount_lkr.toLocaleString(locale)}
              </p>
              <p className="mt-design-1 text-caption text-ink-secondary" data-testid="estimate-model">
                {detail.ai_assisted_estimate.model_version}
              </p>
              {/* A prototype figure has to carry that label wherever it is shown, not only in the
                  thesis. Nothing about the amount itself reveals what it was trained on. */}
              {detail.ai_assisted_estimate.synthetic_model && (
                <p className="mt-design-1 text-caption font-semibold text-status-warning" data-testid="estimate-synthetic">
                  {t("caseReview.estimateSynthetic")}
                </p>
              )}
            </>
          ) : (
            <p className="mt-design-2 text-body text-ink-secondary">{t("caseReview.noEstimate")}</p>
          )}
          <p className="mt-design-2 text-caption font-semibold text-status-warning">{t("caseReview.estimateDisclaimer")}</p>
        </section>

        {/* ------------------------------------------------------------ history */}
        <section className="rounded-md border border-border-subtle bg-surface-raised p-design-4">
          <h2 className="text-headline text-ink-primary">{t("caseReview.historyTitle")}</h2>
          <ol className="mt-design-2 space-y-design-1" data-testid="case-history">
            {history.map((h, i) => (
              <li key={`${h.event}-${i}`} className="flex justify-between gap-design-2 text-caption text-ink-secondary">
                <span className="text-ink-primary">
                  {isWorkflowEvent(h.event) ? t(`caseReview.events.${h.event}`) : h.event.replace(/_/g, " ")}
                </span>
                <span>{formatDateTime(h.created_at, locale)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function labelFor(t: ReturnType<typeof useTranslations>, classId: string | null): string | null {
  if (classId === "crop_damage" || classId === "property_damage" || classId === "no_damage") {
    return t(`aiResult.${classId}`);
  }
  return classId;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-caption text-ink-secondary">{label}</dt>
      <dd className="text-body text-ink-primary">{value || "—"}</dd>
    </div>
  );
}
