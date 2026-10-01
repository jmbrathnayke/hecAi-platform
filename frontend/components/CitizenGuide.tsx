"use client";
// "How to use this app", step by step, on the citizen profile. In the active language (si/ta/en):
// the language control on every citizen screen switches it like everything else.
//
// A native <details> rather than a custom accordion: it opens and closes with no script, is
// announced correctly by screen readers, and keeps working if hydration is slow on a village
// connection. Open by default for a family that has not registered yet, who most need it; closed
// for one that has, so it does not push their own details below the fold.
import { useTranslations } from "next-intl";

const STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export function CitizenGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const t = useTranslations("guide");
  return (
    <details
      data-testid="citizen-guide"
      open={defaultOpen}
      className="group rounded-md border border-border-subtle bg-surface-raised shadow-card"
    >
      <summary className="flex min-h-touch-target cursor-pointer list-none items-center justify-between gap-design-3 p-design-5">
        <span className="flex items-center gap-design-3">
          <span aria-hidden="true" className="text-title">
            📖
          </span>
          <span className="text-headline text-ink-primary">{t("title")}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-ink-secondary transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>

      <div className="flex flex-col gap-design-4 px-design-5 pb-design-5">
        <p className="text-body text-ink-secondary">{t("intro")}</p>
        <ol className="flex flex-col gap-design-4">
          {STEPS.map((n) => (
            <li key={n} className="flex gap-design-3">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-forest text-label font-semibold text-ink-on-dark"
              >
                {n}
              </span>
              <div className="flex min-w-0 flex-col gap-design-1">
                <h3 className="text-label font-semibold text-ink-primary">{t(`s${n}Title`)}</h3>
                <p className="text-body text-ink-secondary">{t(`s${n}Body`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
