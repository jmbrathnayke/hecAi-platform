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
  onAccept: () => void;
  onOverride: () => void;
}

export function AIResultCard({
  classId,
  severity,
  confidence,
  processingTimeMs,
  modelVersion,
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
      </div>

      <div className="flex items-start justify-between gap-design-3">
        <h2 className="text-headline text-ink-primary">{t(`aiResult.${classId}`)}</h2>
        <span className="bg-amber-pale text-amber text-caption font-semibold rounded-pill px-design-3 py-design-1">
          {t(`severity.${severity}`)}
        </span>
      </div>

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
      </div>

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
