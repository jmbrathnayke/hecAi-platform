// AI classification result panel (Story 5.4 AC2). inference_log is effectively empty in
// production today (POST /api/v1/inference/log exists but nothing calls it yet — see the
// story's Dev Notes § Known Data Coverage), so the empty state below is the common case for
// real cases, not a rare edge case — it must be a first-class, tested path.
import type { AdminAiResult } from "@/lib/adminCaseDetail";

interface AIResultPanelProps {
  aiResult: AdminAiResult | null;
}

export function AIResultPanel({ aiResult }: AIResultPanelProps) {
  if (!aiResult) {
    return (
      <div className="rounded-md border border-dashed border-border-default p-design-4 text-body text-ink-disabled">
        Not yet AI-classified.
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
    <div className="rounded-md border border-border-default bg-surface-raised p-design-4 space-y-design-2">
      <h3 className="text-heading-3 text-ink-primary">AI Classification</h3>

      <div className="flex items-center gap-design-3">
        <span className="text-body font-medium text-ink-primary">{aiResult.prediction}</span>
        {aiResult.ai_severity && (
          <span className="rounded-full bg-amber-pale px-design-2 py-0.5 text-caption font-medium text-amber">
            {aiResult.ai_severity}
          </span>
        )}
      </div>

      {confidencePct != null && (
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-tint">
            <div
              className="h-full rounded-full bg-forest"
              style={{ width: `${confidencePct}%` }}
              role="progressbar"
              aria-valuenow={confidencePct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <p className="mt-design-1 text-caption text-ink-secondary">{confidencePct}% confidence</p>
        </div>
      )}

      <p className="text-caption text-ink-disabled">{aiResult.model_version}</p>

      {aiResult.was_overridden && (
        <div className="rounded-md border border-amber bg-amber-pale p-design-3 text-body text-ink-primary">
          <p>
            Original AI class: <span className="font-medium">{aiResult.prediction}</span>
          </p>
          <p>
            Officer override: <span className="font-medium">{aiResult.override_category}</span>
          </p>
          {aiResult.override_reason && (
            <p className="mt-design-1 text-ink-secondary">Reason: {aiResult.override_reason}</p>
          )}
        </div>
      )}
    </div>
  );
}
