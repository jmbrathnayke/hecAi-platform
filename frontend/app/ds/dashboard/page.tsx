"use client";
// Divisional Secretariat case list (Story 8.5).
//
// A SEPARATE SURFACE from /admin, not a variant of it: the DWC administrator oversees a district's
// pipeline, the DS office authorises payment for its own division one level below. Both roles
// exist at once and neither widens the other.
//
// Sits outside app/[locale]/ like /officer and /admin, so it uses the non-routed i18n provider
// (architecture AD-6, Epic 6) — and it is trilingual from the first commit rather than shipped
// English-first and retrofitted, which is the mistake Epic 6 existed to correct.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { fetchDsCases, type DsCase, type DsFailure } from "@/lib/dsCases";
import { PaymentAuthorizationPanel } from "@/components/PaymentAuthorizationPanel";
import PushNotificationToggle from "@/components/PushNotificationToggle";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; failure: DsFailure };

/** Which message explains this failure. Beside the union so a new reason cannot be forgotten. */
function failureKey(f: DsFailure): string {
  switch (f.reason) {
    case "config":
    case "no-session":
      return "error.signedOut";
    case "signed-out":
      return "error.signedOut";
    case "forbidden":
      return "error.forbidden";
    case "no-division":
      return "error.noDivision";
    case "network":
      return "error.network";
    default:
      return "error.server";
  }
}

/** Retry only where it can help. No amount of retrying assigns a division or grants a role. */
function isRetryable(f: DsFailure): boolean {
  return f.reason === "network" || f.reason === "server";
}

export default function DsDashboardPage() {
  const t = useTranslations("ds");

  const [cases, setCases] = useState<DsCase[]>([]);
  const [dsDivision, setDsDivision] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  // Only one case's payment panel is open at a time — a full account number on screen is not
  // something to leave scattered across a list.
  const [payingFor, setPayingFor] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await fetchDsCases(statusFilter || undefined);
      if (!active) return;
      if (result.ok) {
        setCases(result.cases);
        setDsDivision(result.dsDivision);
        setState({ kind: "ready" });
      } else {
        setState({ kind: "failed", failure: result.failure });
      }
    })();
    return () => {
      active = false;
    };
  }, [statusFilter, reloadNonce]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-design-6 px-design-5 py-design-6">
      <header className="flex flex-col gap-design-1">
        <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>
        {/* FR-6.4. This is the surface the alert matters most on: approval is when the DS
            office acquires work, and before this the only way to learn of it was to open
            this page and look. */}
        <div className="mt-design-3">
          <PushNotificationToggle variant="staff" />
        </div>
        {dsDivision && (
          // Named explicitly, so a DS officer is never in doubt about whose cases these are.
          <p className="text-body text-ink-secondary">
            {t("divisionLabel")}: <span className="font-semibold">{dsDivision}</span>
          </p>
        )}
      </header>

      <div className="flex flex-wrap gap-design-2">
        {["", "Submitted", "Under Review", "Approved", "Payment Processed"].map((s) => (
          <button
            key={s || "all"}
            type="button"
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            className={`min-h-touch-target rounded-md border px-design-3 text-label font-semibold ${
              statusFilter === s
                ? "border-forest bg-forest text-ink-on-dark"
                : "border-border-default text-ink-primary"
            }`}
          >
            {s || t("filterAll")}
          </button>
        ))}
      </div>

      {state.kind === "loading" && (
        <p role="status" aria-live="polite" className="text-body text-ink-secondary">
          {t("loading")}
        </p>
      )}

      {state.kind === "failed" && (
        <div role="alert" className="flex flex-col gap-design-2">
          <p className="text-body text-status-error">{t(failureKey(state.failure))}</p>
          {"status" in state.failure && (
            // The status and the backend's own code. An officer can ignore it; it is the first
            // thing anyone debugging needs, and it is what otherwise requires opening DevTools.
            <p className="text-caption text-ink-secondary">
              {t("error.detail", {
                status: state.failure.status,
                code: state.failure.code || "—",
              })}
            </p>
          )}
          {isRetryable(state.failure) && (
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="min-h-touch-target self-start rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
            >
              {t("retry")}
            </button>
          )}
        </div>
      )}

      {state.kind === "ready" && cases.length === 0 && (
        <p className="text-body text-ink-secondary">{t("empty")}</p>
      )}

      {state.kind === "ready" && cases.length > 0 && (
        <ul className="flex flex-col gap-design-3">
          {cases.map((c) => (
            <li
              key={c.canonical_id}
              className="rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card"
              data-testid="ds-case"
            >
              <div className="flex items-baseline justify-between gap-design-3">
                <span className="text-label font-semibold text-ink-primary">
                  {c.canonical_id}
                </span>
                <span className="text-caption text-ink-secondary">{c.status}</span>
              </div>
              <p className="text-caption text-ink-secondary">
                {/* A case with no household predates Epic 8 or is seeded research data
                    (migration 025). Saying so beats rendering an empty field. */}
                {t("household")}: {c.household_ref ?? t("noHousehold")}
              </p>

              {/* Offered only for an approved case with a household. The DWC administrator
                  approves; the DS office pays — so there is nothing to authorise before that,
                  and nobody to pay without a registered family. */}
              {c.status === "Approved" && c.household_ref && payingFor !== c.canonical_id && (
                <button
                  type="button"
                  onClick={() => setPayingFor(c.canonical_id)}
                  className="mt-design-2 min-h-touch-target rounded-md border border-forest px-design-3 text-label font-semibold text-forest"
                >
                  {t("payment.title")}
                </button>
              )}

              {payingFor === c.canonical_id && (
                <div className="mt-design-3">
                  <PaymentAuthorizationPanel
                    canonicalId={c.canonical_id}
                    t={t}
                    onClose={() => setPayingFor(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Link href="/" className="text-label font-semibold text-forest">
        ← HEC
      </Link>
    </main>
  );
}
