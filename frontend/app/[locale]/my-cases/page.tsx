"use client";
// Citizen "My Cases" (Story 4.0). Localized, session-protected (middleware). Lists the cases the
// signed-in citizen owns via GET /api/v1/citizen/cases (scoped + PII-free by the backend).
//
// REBUILT because the page reported four different situations as one sentence. Its state was
// loading / error / ready, so "you are not signed in", "your session expired", "the server is
// down" and "you are offline" all rendered as "Couldn't load your cases." with a Retry button —
// and for the first two, Retry can never succeed. A citizen who had simply signed out was told the
// system had failed and handed a button that fails every time they press it. lib/citizenCases.ts
// now returns a discriminated failure and this page gives each one its own words and its own
// action: sign in where that is the obstacle, retry only where retrying can help.
//
// Three further defects went with it: `case.status` was rendered as the raw English column value
// in all three languages, every status chip was the same neutral grey, and dates were formatted
// with the browser's locale rather than the one the reader had chosen.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { signOutCitizen } from "@/lib/citizenSession";
import {
  fetchMyCases,
  isRetryable,
  needsSignIn,
  type CitizenCase,
  type CitizenFailure,
} from "@/lib/citizenCases";
import { StatusChip } from "@/components/StatusChip";
import { PhotoDeliveryStatus } from "@/components/PhotoDeliveryStatus";
import PushNotificationToggle from "@/components/PushNotificationToggle";
import NotificationBell from "@/components/NotificationBell";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; cases: CitizenCase[] }
  | { kind: "failed"; failure: CitizenFailure };

/** Which pair of messages explains this failure. Beside the union so a new reason cannot be missed. */
function messageKeys(failure: CitizenFailure): { title: string; body: string } {
  switch (failure.reason) {
    case "no-session":
      return { title: "signedOutTitle", body: "signedOutBody" };
    case "signed-out":
      return { title: "expiredTitle", body: "expiredBody" };
    case "network":
      return { title: "networkTitle", body: "networkBody" };
    default:
      return { title: "serverTitle", body: "serverBody" };
  }
}

export default function MyCasesPage() {
  const t = useTranslations("myCases");
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Bumped by Retry to force a re-fetch (a same-value setState would be an Object.is no-op and
  // would NOT re-run the effect — Story 3.7 lesson).
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      setState({ kind: "loading" });
      const result = await fetchMyCases();
      if (!active) return;
      setState(
        result.ok ? { kind: "ready", cases: result.cases } : { kind: "failed", failure: result.failure },
      );
    })();
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  const formatDate = useCallback(
    (iso: string | null): string => {
      if (!iso) return "—";
      const d = new Date(iso);
      // Formatted in the locale the reader chose, not the browser's: the app is trilingual and the
      // handset's own language is frequently not the one the citizen is reading in.
      return Number.isNaN(d.getTime())
        ? "—"
        : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
    },
    [locale],
  );

  function categoryLabel(category: string | null): string | null {
    if (!category) return null;
    // Unknown categories fall through to the raw value rather than a missing-key crash.
    const known = ["crop", "property", "combined"];
    return known.includes(category) ? t(`category.${category}`) : category;
  }

  async function handleSignOut() {
    await signOutCitizen();
    router.push(`/${locale}/login`);
  }

  const signedIn = state.kind !== "failed" || !needsSignIn(state.failure);

  return (
    <main className="flex-1 bg-surface-base pb-design-8">
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-design-3 px-design-5 py-design-4">
          <div className="min-w-0">
            <h1 className="truncate text-headline text-ink-primary">{t("title")}</h1>
            <p className="truncate text-caption text-ink-secondary">{t("subtitle")}</p>
          </div>
          {/* The bell sits beside Sign out, the only other account-level control on this screen.
              Shown only to a signed-in visitor: a feed is per-account, and there is nothing to
              show without one. */}
          {signedIn && <NotificationBell home="/my-cases" tone="light" />}
          {/* Offered only when there is a session to end. Showing "Sign out" to a signed-out
              visitor was part of what made the old error screen so confusing. */}
          {signedIn && (
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="min-h-touch-target shrink-0 rounded-md border border-border-default px-design-3 text-caption font-medium text-ink-secondary transition-colors duration-quick hover:bg-surface-base"
            >
              {t("signOut")}
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-design-4 px-design-5 py-design-6">
        {state.kind === "loading" && (
          <p role="status" className="text-body text-ink-secondary">
            {t("loading")}
          </p>
        )}

        {state.kind === "failed" && (
          <div
            role="alert"
            className="flex flex-col items-start gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card"
          >
            <div>
              <p className="text-headline text-ink-primary">{t(messageKeys(state.failure).title)}</p>
              <p className="mt-design-2 text-body text-ink-secondary">
                {t(messageKeys(state.failure).body)}
              </p>
            </div>

            <div className="flex flex-col gap-design-3 sm:flex-row sm:items-center">
              {needsSignIn(state.failure) && (
                <Link
                  href={`/${locale}/login`}
                  className="flex min-h-touch-target items-center justify-center rounded-md bg-amber px-design-5 text-label font-semibold text-ink-on-amber transition-opacity duration-quick hover:opacity-90"
                >
                  {t("signIn")}
                </Link>
              )}
              {isRetryable(state.failure) && (
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                  className="flex min-h-touch-target items-center justify-center rounded-md border border-forest px-design-5 text-label font-semibold text-forest transition-colors duration-quick hover:bg-forest-pale"
                >
                  {t("retry")}
                </button>
              )}
              {/* Always available, and the point of FR-6.1: a reference number needs no account,
                  so someone who cannot sign in is not cut off from their own claim. */}
              <Link
                href={`/${locale}/status`}
                className="text-label font-semibold text-forest underline underline-offset-4"
              >
                {t("checkByReference")}
              </Link>
            </div>
          </div>
        )}

        {state.kind === "ready" && state.cases.length === 0 && (
          <div className="rounded-md border border-dashed border-border-default px-design-5 py-design-6 text-center">
            <p className="text-headline text-ink-primary">{t("emptyTitle")}</p>
            <p className="mt-design-2 text-body text-ink-secondary">{t("empty")}</p>
          </div>
        )}

        {state.kind === "ready" && state.cases.length > 0 && (
          <ul className="flex flex-col gap-design-3">
            {state.cases.map((c) => (
              <li
                key={c.offline_id ?? c.canonical_id}
                className="rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-design-2">
                  <span className="select-all font-mono text-label font-semibold text-ink-primary">
                    {c.canonical_id ?? "…"}
                  </span>
                  <StatusChip status={c.status} />
                </div>
                <dl className="mt-design-3 flex flex-wrap gap-x-design-5 gap-y-design-1">
                  {categoryLabel(c.damage_category) && (
                    <div>
                      <dt className="sr-only">{t("title")}</dt>
                      <dd className="text-body text-ink-primary">
                        {categoryLabel(c.damage_category)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-caption text-ink-secondary">{t("submittedOn")}</dt>
                    <dd className="text-body text-ink-primary">{formatDate(c.submitted_at)}</dd>
                  </div>
                </dl>
                {/* Whether this case's photographs reached the DWC, from this phone's own outbox.
                    Nothing is shown for a report filed on another device. */}
                {c.offline_id && (
                  <div className="mt-design-3">
                    <PhotoDeliveryStatus offlineId={c.offline_id} canonicalId={c.canonical_id} autoSend={false} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Below the list, not above it: the citizen came here to see their claims, and a permission
            prompt competing with that is how prompts get dismissed permanently. Renders nothing on a
            browser or deployment where push cannot work. */}
        <PushNotificationToggle />
      </div>
    </main>
  );
}
