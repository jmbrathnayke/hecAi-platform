// The journey a compensation claim travels, with the claim's current position on it (FR-6.1).
//
// WHY A PROGRESS INDICATOR AND NOT JUST A BADGE. The public status page answers one question for a
// family waiting on money, and the old card answered only half of it: it said "Approved" but not
// what that meant, what had already happened, or what happens next. Four of the five statuses are
// waypoints rather than outcomes, and a single chip renders them all as though the claim had
// stopped there.
//
// REJECTION IS NOT A STEP. A rejected claim did not travel further than a pending one, so it is
// not rendered on this track at all — placing it at the end of a progress bar would tell a family
// their claim had completed. StatusCard renders that case as its own terminal notice instead.
//
// NEVER COLOUR ALONE. Each step carries a text label and, for the reached ones, a tick; the
// current step is additionally marked with aria-current so it is announced rather than merely
// shown. WCAG 1.4.1.
"use client";

import { useTranslations } from "next-intl";
import { CLAIM_JOURNEY, journeyIndex, statusKey } from "@/lib/status";

export function ClaimProgress({ status }: { status: string }) {
  const t = useTranslations("status");
  const current = journeyIndex(status);
  if (current < 0) return null;

  return (
    <div>
      <h3 className="text-label font-semibold text-ink-secondary">{t("progressTitle")}</h3>
      <ol className="mt-design-3 flex items-start">
        {CLAIM_JOURNEY.map((step, i) => {
          const reached = i <= current;
          const isCurrent = i === current;
          return (
            <li
              key={step}
              className="flex flex-1 flex-col items-center text-center"
              aria-current={isCurrent ? "step" : undefined}
            >
              <div className="flex w-full items-center">
                {/* Connectors are drawn as siblings of the marker rather than as a single line
                    behind the row, so the track reflows correctly when a translated label wraps to
                    two lines in Sinhala or Tamil. */}
                <span
                  aria-hidden="true"
                  className={`h-0.5 flex-1 ${i === 0 ? "invisible" : reached ? "bg-forest" : "bg-border-subtle"}`}
                />
                <span
                  aria-hidden="true"
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-caption font-bold transition-colors duration-base ${
                    reached
                      ? "border-forest bg-forest text-ink-on-dark"
                      : "border-border-default bg-surface-raised text-ink-disabled"
                  } ${isCurrent ? "ring-4 ring-forest-pale" : ""}`}
                >
                  {reached && !isCurrent ? "✓" : i + 1}
                </span>
                <span
                  aria-hidden="true"
                  className={`h-0.5 flex-1 ${
                    i === CLAIM_JOURNEY.length - 1
                      ? "invisible"
                      : i < current
                        ? "bg-forest"
                        : "bg-border-subtle"
                  }`}
                />
              </div>
              <span
                className={`mt-design-2 px-design-1 text-caption ${
                  isCurrent ? "font-semibold text-ink-primary" : "text-ink-secondary"
                }`}
              >
                {t(`statusLabels.${statusKey(step)}`)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
