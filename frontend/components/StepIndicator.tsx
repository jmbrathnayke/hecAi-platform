// 4-step progress indicator for the incident form (UX-DR3).
// Presentational only — current step is driven by the parent page.

interface StepIndicatorProps {
  steps: string[];
  currentStep: number; // 0-indexed
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <ol className="flex w-full items-start justify-between" aria-label="Form progress">
      {steps.map((label, i) => {
        const state = i < currentStep ? "complete" : i === currentStep ? "active" : "upcoming";
        const circle =
          state === "complete"
            ? "bg-forest text-ink-on-dark"
            : state === "active"
              ? "bg-amber text-ink-on-amber"
              : "bg-surface-tint text-ink-disabled";
        return (
          <li
            key={label}
            className="flex flex-1 flex-col items-center gap-design-1"
            aria-current={state === "active" ? "step" : undefined}
          >
            <div className="flex w-full items-center">
              {/* left connector */}
              <span
                className={`h-0.5 flex-1 ${i === 0 ? "opacity-0" : i <= currentStep ? "bg-forest" : "bg-border-default"}`}
                aria-hidden="true"
              />
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-label font-semibold ${circle}`}
              >
                {i + 1}
              </span>
              {/* right connector */}
              <span
                className={`h-0.5 flex-1 ${i === steps.length - 1 ? "opacity-0" : i < currentStep ? "bg-forest" : "bg-border-default"}`}
                aria-hidden="true"
              />
            </div>
            <span
              className={`text-center text-caption ${state === "upcoming" ? "text-ink-disabled" : "text-ink-secondary"}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
