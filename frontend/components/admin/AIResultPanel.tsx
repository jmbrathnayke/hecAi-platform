"use client";

// AI classification result panel (Story 5.4 AC2). inference_log is effectively empty in
// production today (POST /api/v1/inference/log exists but nothing calls it yet — see the
// story's Dev Notes § Known Data Coverage), so the empty state below is the common case for
// real cases, not a rare edge case — it must be a first-class, tested path. Localized si/ta/en
// (Story 6.3): only chrome is translated — the stored prediction / ai_severity / override values
// and model_version are raw record data, shown verbatim to the reviewing admin.
import { useTranslations } from "next-intl";
import type { AdminAiResult } from "@/lib/adminCaseDetail";

interface AIResultPanelProps {
  aiResult: AdminAiResult | null;
}

export function AIResultPanel({ aiResult }: AIResultPanelProps) {
  const t = useTranslations("admin");

  if (!aiResult) {
    return (
      <div className="rounded-md border border-dashed border-border-subtle p-design-4 text-label text-ink-secondary">
        {t("ai.empty")}
      </div>
    );
  }

  // Clamped to [0,100] (code review fix): the backend validates confidence is 0..1 at write
  // time (inference.py), so this is defensive rather than currently reachable -- but an
  // out-of-range value must not produce a progress bar wider than its container or a
  // negative width.
  const confidencePct =
    aiResult.confidence != null
      ? Math.min(100, Math.max(0, Math.round(aiResult.confidence * 100)))
      : null;

  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4 space-y-design-3">
      {/* was `text-heading-3` — never defined in the theme, so preflight left this rendering at
          plain body size/weight. DESIGN.md: "Headline (18px / 600) is section and card headings." */}
      <h3 className="text-label font-semibold text-ink-primary">{t("ai.heading")}</h3>

      <div className="flex items-center gap-design-3">
        <span className="text-body font-medium text-ink-primary">{aiResult.prediction}</span>
        {aiResult.ai_severity && (
          <span className="rounded-sm bg-amber-pale px-design-2 py-0.5 text-caption font-medium text-amber">
            {aiResult.ai_severity}
          </span>
        )}
      </div>

      {/* A gated row reads "no_damage" like any other, and the administrator decides against it.
          Without this line the only difference between "the officer photographed undamaged land"
          and "the model could not recognise the photo at all" is invisible on this screen. */}
      {aiResult.out_of_domain && (
        <p
          data-testid="ood-notice"
          className="rounded-sm border border-amber/40 bg-amber-pale p-design-3 text-label text-ink-primary"
        >
          {t("ai.outOfDomain")}
        </p>
      )}

      {confidencePct != null && !aiResult.out_of_domain && (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-tint">
            <div
              className="h-full rounded-pill bg-forest"
              style={{ width: `${confidencePct}%` }}
              role="progressbar"
              aria-valuenow={confidencePct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <p className="mt-design-1 text-caption text-ink-secondary">
            {t("ai.confidence", { pct: confidencePct })}
          </p>
          {/* The administrator decides whether to approve against this number, so it matters more
              here than anywhere that it is not read as a probability of correctness. Closed-set
              softmax over three classes: see AIResultCard for the full reasoning and the two
              recorded cases (a face at 94% property damage; a no-damage photo at 88.3% crop). */}
          <p className="mt-design-1 text-caption text-ink-secondary" data-testid="confidence-caveat">
            {t("ai.confidenceCaveat")}
          </p>
        </div>
      )}

      <p className="font-staff-mono text-caption text-ink-secondary">{aiResult.model_version}</p>

      {/* What the classification is evidence of. A result from the family's own photograph means
          no officer has photographed the damage; the approver should know that before deciding. */}
      {(aiResult.input_source === "citizen_photo" || aiResult.input_source === "officer_capture") && (
        <p className="text-caption text-ink-secondary" data-testid="ai-input-source">
          {t("ai.classifiedFrom")} <span className="font-medium text-ink-primary">{t(`ai.inputSource.${aiResult.input_source}`)}</span>
        </p>
      )}

      {aiResult.was_overridden && (
        <div className="rounded-sm border border-amber/40 bg-amber-pale p-design-3 text-label text-ink-primary">
          <p>
            {t("ai.originalClass")} <span className="font-medium">{aiResult.prediction}</span>
          </p>
          <p>
            {t("ai.officerOverride")}{" "}
            <span className="font-medium">{aiResult.override_category}</span>
          </p>
          {aiResult.override_reason && (
            <p className="mt-design-1 text-ink-secondary">
              {t("ai.reasonLabel")} {aiResult.override_reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
