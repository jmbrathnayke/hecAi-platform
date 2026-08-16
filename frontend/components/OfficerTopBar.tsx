// Officer screen chrome (officer-camera.html mockup: the white bar directly under the status
// bar — "Step 4: Photos" on the left, the step dots on the right).
//
// One component for every officer screen, because the mockup gives them all the same bar and
// only the trailing slot differs:
//   /officer/submit    label + step dots
//   /officer/classify  label + "Start new case"
//   /officer/dashboard label + "Sync Queue"
//   /officer/sync      label alone
//
// Deliberately NOT the citizen StepIndicator: that one is a numbered-circle rail with a text
// label under every step, which needs the full page width and cannot be pinned above a
// full-bleed camera viewport. This variant is a single ~44px bar, so it stays visible while the
// camera owns the screen.
//
// The dots are decorative (aria-hidden): `label` already carries the progress in words
// ("Step 4 of 5 — Photo & Classification"), so announcing them too is redundant for a
// screen-reader user. `label` is rendered as the screen's <h1> so each officer route keeps
// exactly one top-level heading.

import type { ReactNode } from "react";

interface OfficerTopBarProps {
  /** Screen or step title. Rendered as the page's <h1>. */
  label: string;
  /** Total dots to render. Omit on non-stepped screens to hide the dot rail entirely. */
  totalSteps?: number;
  /** 0-indexed current step. Dots before it render complete, after it upcoming. */
  currentStep?: number;
  /** Trailing slot — a link or button. Ignored when step dots are shown. */
  action?: ReactNode;
}

export function OfficerTopBar({ label, totalSteps, currentStep = 0, action }: OfficerTopBarProps) {
  return (
    <div
      data-testid="officer-top-bar"
      className="flex items-center justify-between gap-design-3 border-b border-border-default bg-surface-raised px-design-5 py-design-3"
    >
      <h1 className="text-label font-semibold text-ink-primary">{label}</h1>

      {totalSteps != null ? (
        <div className="flex shrink-0 gap-design-2" aria-hidden="true">
          {Array.from({ length: totalSteps }, (_, i) => {
            const state = i < currentStep ? "done" : i === currentStep ? "active" : "upcoming";
            return (
              <span
                key={i}
                data-state={state}
                // The active dot gets the mockup's pale halo via a ring rather than a box-shadow,
                // so it costs no layout and the dots stay evenly spaced.
                className={`h-design-3 w-design-3 rounded-pill ${
                  state === "done"
                    ? "bg-forest-mid"
                    : state === "active"
                      ? "bg-forest ring-2 ring-forest-pale"
                      : "bg-border-default"
                }`}
              />
            );
          })}
        </div>
      ) : (
        action
      )}
    </div>
  );
}
