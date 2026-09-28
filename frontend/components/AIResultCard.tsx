"use client";

// AI Result Card (Story 3.3, UX-DR12/13, DESIGN.md "AI Result Card"). Localized si/ta/en
// (Story 6.2, FR-9.1) via the officer i18n provider added in Story 6.1 — the class labels,
// severity, confidence and CTAs read from the `officer` message namespace. Shows the on-device
// classification with an always-visible confidence signal, and never auto-advances: the officer
// must tap Accept or Override (NFR-6.1).

import { useTranslations } from "next-intl";
import type { ClassId, Severity } from "@/lib/mobilenet";

export interface AIResultCardProps {
  classId: ClassId;
  severity: Severity;
  confidence: number; // 0..1
  processingTimeMs: number;
  modelVersion: string;
  /** The open-set gate rejected the photo (lib/oodGate.ts). `classId` is then `no_damage`, but
   *  because nothing was recognised — not because an intact field was. The card must say which,
   *  or the officer reads "No Damage" as a finding about the land. */
  outOfDomain?: boolean;
  onAccept: () => void;
  onOverride: () => void;
}

export function AIResultCard({
  classId,
  severity,
  confidence,
  processingTimeMs,
  modelVersion,
  outOfDomain = false,
  onAccept,
  onOverride,
}: AIResultCardProps) {
  const t = useTranslations("officer");
  // Clamp to [0,100] and guard non-finite so the bar width + aria-valuenow stay valid even if
  // an out-of-range/NaN confidence ever reaches the card.
  const confidencePct = Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence * 100)))
    : 0;

  return (
    <section
      data-testid="ai-result-card"
      aria-label={t("aiResult.cardLabel")}
      className="border-l-4 border-forest bg-surface-raised rounded-md p-design-4 space-y-design-4"
    >
      {/* Section label + "Auto" chip (mockup): marks the result as machine-produced, which is
          what the Override affordance below is a response to. */}
      <div className="flex items-center gap-design-2">
        <span className="text-label font-semibold text-ink-primary">
          {t("aiResult.sectionLabel")}
        </span>
        <span className="rounded-pill bg-forest-pale px-design-2 py-0.5 text-caption font-semibold text-forest">
          {t("aiResult.autoChip")}
        </span>
        {outOfDomain && (
          <span
            data-testid="ood-badge"
            className="rounded-pill bg-amber-pale px-design-2 py-0.5 text-caption font-semibold text-amber"
          >
            {t("aiResult.outOfDomainBadge")}
          </span>
        )}
      </div>

      <div className="flex items-start justify-between gap-design-3">
        <h2 className="text-headline text-ink-primary">{t(`aiResult.${classId}`)}</h2>
        <span className="bg-amber-pale text-amber text-caption font-semibold rounded-pill px-design-3 py-design-1">
          {t(`severity.${severity}`)}
        </span>
      </div>

      {/* THE GATE'S OWN PANEL. When the photo matched none of the three trained classes there is
          no percentage worth showing: the softmax compares those three against each other, and
          this photo is outside all of them, so the number describes a choice that was discarded.
          The class above already reads "No Damage" — which is the right compensation outcome,
          since a no-damage case is never priced — and this panel supplies the missing half of
          the sentence: that nothing was recognised, not that intact land was. */}
      {outOfDomain ? (
        <div
          role="status"
          data-testid="ood-notice"
          className="rounded-md border border-amber bg-amber-pale p-design-3 space-y-design-2"
        >
          <p className="text-body leading-relaxed text-ink-primary">
            {t("aiResult.outOfDomainNotice")}
          </p>
          <p className="text-caption text-ink-secondary">
            {t("aiResult.outOfDomainNoConfidence")}
          </p>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-label text-ink-secondary">{t("aiResult.confidence")}</span>
            <span className="text-title text-forest">{confidencePct}%</span>
          </div>
          <div
            role="progressbar"
            aria-label={t("aiResult.confidenceBarLabel")}
            aria-valuenow={confidencePct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-design-2 h-[6px] w-full bg-forest-pale rounded-pill overflow-hidden"
          >
            <div className="h-full bg-forest rounded-pill" style={{ width: `${confidencePct}%` }} />
          </div>
          {/* WHAT THE PERCENTAGE IS NOT. The classifier is closed-set: its last layer is a softmax
              over exactly three classes, so the scores always sum to 100% and a high number means
              "this class over the other two", never "this is right". Photos of things outside all
              three are now caught by the gate above rather than scored here — but WITHIN the three
              classes the number is still a preference, not a probability of correctness: the final
              ML evaluation records a no-damage photo classified as crop damage at 88.3%. Saying so
              beside the number is what keeps the officer's Override meaningful. */}
          <p className="mt-design-2 text-caption text-ink-secondary" data-testid="confidence-caveat">
            {t("aiResult.confidenceCaveat")}
          </p>
        </div>
      )}

      {/* Provenance footer (mockup): which model produced this, that it ran on-device, and how
          long it took. The officer needs the model version to make sense of a disputed result. */}
      <p className="text-caption text-ink-secondary">
        {t("aiResult.modelFooter", { model: modelVersion, ms: Math.round(processingTimeMs) })}
      </p>

      {/* Override hint (mockup): tells the officer the result is contestable BEFORE they reach
          for Accept, rather than leaving Override to be discovered. */}
      <p className="flex items-start gap-design-2 rounded-md bg-amber-pale p-design-3 text-caption leading-relaxed text-amber">
        <span aria-hidden="true">⚠️</span>
        {t("aiResult.overrideHint")}
      </p>

      {/* flex-wrap + basis: on a 360px screen two wrapped Sinhala/Tamil CTA labels would
          otherwise compress each other below a readable width; they wrap to their own rows
          instead. */}
      <div className="flex flex-wrap gap-design-3">
        <button
          type="button"
          onClick={onAccept}
          className="min-h-touch-target flex-1 basis-[140px] bg-amber text-ink-on-amber text-label font-semibold rounded-md"
        >
          {t("aiResult.accept")}
        </button>
        <button
          type="button"
          onClick={onOverride}
          className="min-h-touch-target flex-1 basis-[140px] border border-forest text-forest text-label font-semibold rounded-md"
        >
          {t("aiResult.override")}
        </button>
      </div>
    </section>
  );
}
