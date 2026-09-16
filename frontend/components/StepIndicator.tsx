// 4-step progress indicator for the incident form and the registration wizard (UX-DR3).
// Presentational only — current step is driven by the parent page.
//
// A completed step now carries a tick rather than its own number. The number tells you where a
// step sits in the sequence, which is only useful while you still have to get there; once it is
// behind you the question is whether it is done, and a tick answers that at a glance where a
// numeral does not. The active step keeps its number and gains a halo, so "where am I" and "what
// is finished" are two different marks rather than two shades of the same one.
//
// Colour is never the only signal (WCAG 1.4.1): shape distinguishes the three states, and the
// active step is announced through aria-current.

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
            ? "border-forest bg-forest text-ink-on-dark"
            : state === "active"
              ? "border-amber bg-amber text-ink-on-amber ring-4 ring-amber-pale"
              : "border-border-subtle bg-surface-raised text-ink-disabled";
        return (
          <li
            key={label}
            className="flex flex-1 flex-col items-center gap-design-1"
            aria-current={state === "active" ? "step" : undefined}
          >
            <div className="flex w-full items-center">
              {/* left connector */}
              <span
                className={`h-0.5 flex-1 transition-colors duration-base ${
                  i === 0 ? "opacity-0" : i <= currentStep ? "bg-forest" : "bg-border-subtle"
                }`}
                aria-hidden="true"
              />
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-label font-semibold transition-colors duration-base ${circle}`}
              >
                {state === "complete" ? "✓" : i + 1}
              </span>
              {/* right connector */}
              <span
                className={`h-0.5 flex-1 transition-colors duration-base ${
                  i === steps.length - 1
                    ? "opacity-0"
                    : i < currentStep
                      ? "bg-forest"
                      : "bg-border-subtle"
                }`}
                aria-hidden="true"
              />
            </div>
            <span
              className={`text-center text-caption transition-colors duration-base ${
                state === "active"
                  ? "font-semibold text-ink-primary"
                  : state === "upcoming"
                    ? "text-ink-disabled"
                    : "text-ink-secondary"
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
