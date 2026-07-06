"use client";

// AI Result Card (Story 3.3, UX-DR12/13, DESIGN.md "AI Result Card"). Officer portal is
// English-only (FR-9.3, no next-intl provider on /officer/*) — labels are hardcoded English,
// matching the officer/login + ModelLoadStatus convention. Shows the on-device classification
// with an always-visible confidence signal, and never auto-advances: the officer must tap
// Accept or Override (NFR-6.1).

import type { ClassId, Severity } from "@/lib/mobilenet";

const CATEGORY_LABELS: Record<ClassId, string> = {
  crop_damage: "Crop Damage",
  no_damage: "No Damage",
  property_damage: "Property Damage",
};

export interface AIResultCardProps {
  classId: ClassId;
  severity: Severity;
  confidence: number; // 0..1
  processingTimeMs: number;
  onAccept: () => void;
  onOverride: () => void;
}

export function AIResultCard({
  classId,
  severity,
  confidence,
  processingTimeMs,
  onAccept,
  onOverride,
}: AIResultCardProps) {
  // Clamp to [0,100] and guard non-finite so the bar width + aria-valuenow stay valid even if
  // an out-of-range/NaN confidence ever reaches the card.
  const confidencePct = Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence * 100)))
    : 0;

  return (
    <section
      data-testid="ai-result-card"
      aria-label="AI classification result"
      className="border-l-4 border-forest bg-surface-raised rounded-md p-design-4 space-y-design-4"
    >
      <div className="flex items-start justify-between gap-design-3">
        <h2 className="text-headline text-ink-primary">{CATEGORY_LABELS[classId]}</h2>
        <span className="bg-amber-pale text-amber text-caption font-semibold rounded-pill px-design-3 py-design-1">
          {severity}
        </span>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-label text-ink-secondary">Confidence</span>
          <span className="text-title text-forest">{confidencePct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="AI confidence"
          aria-valuenow={confidencePct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-design-2 h-[6px] w-full bg-forest-pale rounded-pill overflow-hidden"
        >
          <div className="h-full bg-forest rounded-pill" style={{ width: `${confidencePct}%` }} />
        </div>
      </div>

      <p className="text-caption text-ink-secondary">Processed on device in {Math.round(processingTimeMs)} ms</p>

      <div className="flex gap-design-3">
        <button
          type="button"
          onClick={onAccept}
          className="flex-1 min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={onOverride}
          className="flex-1 min-h-touch-target border border-forest text-forest text-label font-semibold rounded-md"
        >
          Override
        </button>
      </div>
    </section>
  );
}
