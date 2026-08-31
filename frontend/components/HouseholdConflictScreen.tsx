"use client";
// The duplicate-registration screen (Story 8.3, FR-10.2).
//
// This is the visible face of the platform's integrity control, and almost everyone who sees it
// has done nothing wrong — typically a son registering without knowing his father already did.
// EXPERIENCE.md specifies it as a first-class screen rather than an error state, with five
// requirements, each of which is a named element below:
//
//   1. say the family is already registered, in the citizen's own language — never a code,
//      never the word "error", never "duplicate"
//   2. name the existing household reference, so they have something concrete to quote
//   3. explain WHY in one sentence
//   4. say what to do next (the Divisional Secretariat office)
//   5. offer a real next action — never a bare "Back"
//
// Tone is informative, never accusatory: nothing here suggests the reader attempted anything
// improper. Deliberately NOT styled with the error colour — `status-error` red would contradict
// requirement 1 by reading as a fault.
import { Link } from "@/navigation";

export type ConflictVariant =
  /** The caller's OWN account already holds a household. They are simply done. */
  | "own-account"
  /** The caller's NIC sits in a household someone else registered — a relative. */
  | "family-registered";

interface Props {
  variant: ConflictVariant;
  householdRef: string;
  t: (key: string) => string;
}

export function HouseholdConflictScreen({ variant, householdRef, t }: Props) {
  const isOwn = variant === "own-account";

  return (
    <main
      className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6"
      data-testid="household-conflict"
    >
      {/* (1) The statement. role="status", not "alert" — this is information, not a failure. */}
      <header role="status" aria-live="polite">
        <h1 className="text-title font-bold text-ink-primary">
          {t(isOwn ? "conflict.titleYou" : "conflict.titleFamily")}
        </h1>
      </header>

      {/* (2) The reference, given the same forest-green treatment as the Proof of Claim and the
          registration receipt — the three things a citizen is meant to keep and quote. */}
      <div className="rounded-lg bg-forest p-design-6 text-center">
        <p className="text-label text-ink-on-dark opacity-90">{t("conflict.refLabel")}</p>
        <p
          className="mt-design-2 text-display font-bold text-ink-on-dark"
          data-testid="conflict-household-ref"
        >
          {householdRef}
        </p>
      </div>

      {/* (3) Why. One sentence, stated as a reason rather than a rule. */}
      <p className="text-body text-ink-primary">{t("conflict.why")}</p>

      {/* (4) What to do next. Absent for own-account — there is nothing to sort out. */}
      {!isOwn && (
        <p className="rounded-md bg-surface-tint p-design-4 text-body text-ink-secondary">
          {t("conflict.whatToDo")}
        </p>
      )}

      {/* (5) Real next actions. */}
      <div className="flex flex-col gap-design-3">
        {isOwn && (
          <Link
            href="/report"
            className="inline-flex min-h-touch-target items-center justify-center rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
          >
            {t("conflict.reportIncident")}
          </Link>
        )}
        <Link
          href="/status"
          className="inline-flex min-h-touch-target items-center justify-center rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
        >
          {t("conflict.checkStatus")}
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-touch-target items-center justify-center text-label font-semibold text-ink-secondary"
        >
          {t("conflict.goHome")}
        </Link>
      </div>
    </main>
  );
}
