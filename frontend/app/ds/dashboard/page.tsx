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
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { fetchDsCases, type DsCase, type DsFailure } from "@/lib/dsCases";
import { PaymentAuthorizationPanel } from "@/components/PaymentAuthorizationPanel";
import { DsFinalDecisionPanel } from "@/components/DsFinalDecisionPanel";
import { DsBankDetailsPanel } from "@/components/DsBankDetailsPanel";
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
  // The family's bank account, recorded or corrected at this office. One case at a time again.
  const [bankFor, setBankFor] = useState<string | null>(null);
  // The final compensation review panel, also one case at a time.
  const [decidingFor, setDecidingFor] = useState<string | null>(null);
  const [decidedNotice, setDecidedNotice] = useState<string | null>(null);
  // A "final compensation review required" notification opens /ds/dashboard?ref=HEC-…: that case
  // is highlighted and, if it is waiting for a decision, its review panel is opened.
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const focusHandled = useRef(false);

  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref) setFocusRef(ref.trim().toUpperCase());
    } catch {
      /* no query string to read */
    }
  }, []);

  useEffect(() => {
    if (!focusRef || focusHandled.current || state.kind !== "ready") return;
    const target = cases.find((c) => c.canonical_id === focusRef);
    if (!target) return;
    focusHandled.current = true;
    if (target.status === "Approved" && !target.final_decision && !target.payment_authorized) {
      setDecidingFor(target.canonical_id);
    }
    try {
      document.getElementById(`ds-case-${target.canonical_id}`)?.scrollIntoView({ block: "center" });
    } catch {
      /* scrolling is a convenience */
    }
  }, [focusRef, cases, state.kind]);

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
              id={`ds-case-${c.canonical_id}`}
              className={`rounded-md border bg-surface-raised p-design-4 shadow-card ${
                focusRef === c.canonical_id ? "border-forest ring-4 ring-forest-pale" : "border-border-subtle"
              }`}
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
                {c.household_ref && (
                  <>
                    {" · "}
                    {c.bank_account_last4
                      ? t("bankDetails.current", { last4: c.bank_account_last4 })
                      : t("bankDetails.none")}
                  </>
                )}
              </p>

              {c.household_ref && bankFor !== c.canonical_id && (
                <button
                  type="button"
                  onClick={() => {
                    setPayingFor(null);
                    setDecidingFor(null);
                    setBankFor(c.canonical_id);
                  }}
                  className="mt-design-2 min-h-touch-target self-start rounded-md border border-border-default px-design-3 text-label font-medium text-ink-secondary"
                >
                  {c.bank_account_last4 ? t("bankDetails.change") : t("bankDetails.record")}
                </button>
              )}

              {bankFor === c.canonical_id && c.household_ref && (
                <div className="mt-design-3">
                  <DsBankDetailsPanel
                    householdRef={c.household_ref}
                    currentLast4={c.bank_account_last4 ?? null}
                    t={t}
                    onSaved={(last4) =>
                      setCases((prev) =>
                        prev.map((x) =>
                          x.household_ref === c.household_ref
                            ? { ...x, bank_account_last4: last4 }
                            : x,
                        ),
                      )
                    }
                    onClose={() => setBankFor(null)}
                  />
                </div>
              )}

              {(c.status === "Approved" || c.status === "Payment Processed") && (
                // What the DS officer decides from: the AI-assisted estimate (decision support), the
                // DWC recommendation, and -- once made -- the recorded final decision.
                <dl className="mt-design-2 grid grid-cols-1 gap-design-1 text-caption text-ink-secondary sm:grid-cols-3">
                  <div>
                    <dt>{t("finalDecision.aiEstimate")}</dt>
                    <dd className="text-ink-primary">
                      {typeof c.ai_estimate?.amount_lkr === "number" ? `LKR ${c.ai_estimate.amount_lkr.toLocaleString()}` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("finalDecision.dwcAmount")}</dt>
                    <dd className="text-ink-primary">
                      {typeof c.approved_amount === "number" ? `LKR ${c.approved_amount.toLocaleString()}` : "—"}
                    </dd>
                  </div>
                  <div data-testid="ds-final-amount">
                    <dt>{t("finalDecision.decided")}</dt>
                    <dd className="font-semibold text-forest">
                      {typeof c.final_decision?.amount_lkr === "number" ? `LKR ${c.final_decision.amount_lkr.toLocaleString()}` : "—"}
                    </dd>
                  </div>
                </dl>
              )}

              {decidedNotice === c.canonical_id && (
                <p role="status" className="mt-design-2 text-caption text-forest">
                  {t("finalDecision.recorded")}
                </p>
              )}

              {/* Step 1 for an approved case: the human final decision on the amount. Revisable
                  until payment is authorised. */}
              {c.status === "Approved" && !c.payment_authorized && decidingFor !== c.canonical_id && (
                <button
                  type="button"
                  onClick={() => {
                    setPayingFor(null);
                    setDecidingFor(c.canonical_id);
                  }}
                  className="mt-design-2 mr-design-2 min-h-touch-target rounded-md border border-forest px-design-3 text-label font-semibold text-forest"
                >
                  {c.final_decision ? t("finalDecision.revise") : t("finalDecision.title")}
                </button>
              )}

              {decidingFor === c.canonical_id && (
                <div className="mt-design-3">
                  <DsFinalDecisionPanel
                    dsCase={c}
                    t={t}
                    onCancel={() => setDecidingFor(null)}
                    onDecided={(decision) => {
                      setCases((prev) =>
                        prev.map((x) =>
                          x.canonical_id === c.canonical_id
                            ? {
                                ...x,
                                final_decision: {
                                  amount_lkr: decision.amount_lkr,
                                  reason: decision.reason,
                                  decided_at: decision.decided_at,
                                },
                              }
                            : x,
                        ),
                      );
                      setDecidingFor(null);
                      setDecidedNotice(c.canonical_id);
                    }}
                  />
                </div>
              )}

              {/* Step 2: payment. Offered only for an approved case with a household AND a recorded
                  final decision -- the DWC administrator approves, the DS office decides the amount,
                  then pays. (A case already authorised can re-reveal the account number.) */}
              {c.status === "Approved" && c.household_ref && !c.final_decision && !c.payment_authorized && (
                <p className="mt-design-2 text-caption text-ink-secondary">{t("finalDecision.requiredBeforePayment")}</p>
              )}
              {c.status === "Approved" && c.household_ref && (c.final_decision || c.payment_authorized) &&
                payingFor !== c.canonical_id && (
                <button
                  type="button"
                  onClick={() => {
                    setDecidingFor(null);
                    setPayingFor(c.canonical_id);
                  }}
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
                    onRecordBankDetails={
                      c.household_ref
                        ? () => {
                            setPayingFor(null);
                            setBankFor(c.canonical_id);
                          }
                        : undefined
                    }
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
