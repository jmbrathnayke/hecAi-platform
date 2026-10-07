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
import { useLocale, useTranslations } from "next-intl";
import { fetchDsCases, type DsCase, type DsFailure } from "@/lib/dsCases";
import { PaymentAuthorizationPanel } from "@/components/PaymentAuthorizationPanel";
import { DsFinalDecisionPanel } from "@/components/DsFinalDecisionPanel";
import { PhotoGallery } from "@/components/admin/PhotoGallery";
import { ClaimantDetails } from "@/components/ClaimantDetails";
import { DsBankDetailsPanel } from "@/components/DsBankDetailsPanel";
import {
  ArrowClockwise,
  Bank,
  CheckCircle,
  CreditCard,
  Gavel,
  Images,
  MapPin,
  Tray,
} from "@phosphor-icons/react";
import { PageHeader, Skeleton, StatusBadge, buttonStyles } from "@/components/admin/ui";
import { isTranslatedStatus, statusKey } from "@/lib/status";

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

// The categories the citizen-facing pages already translate; anything else is shown as stored.
const KNOWN_CATEGORIES = ["crop", "property", "combined"];

// The statuses the list can be narrowed to, in the order a case moves through them.
const FILTER_STATUSES = ["Submitted", "Under Review", "Approved", "Payment Processed"];

function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(locale);
}

export default function DsDashboardPage() {
  const t = useTranslations("ds");
  const tCategory = useTranslations("myCases.category");
  const tStatus = useTranslations("status");
  const locale = useLocale();

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
  // Which card has its evidence open. One at a time, like the bank-details panel: the gallery
  // costs an authenticated fetch and a set of signed URLs per case, and firing that for every
  // row of the list would be a burst of work for photographs nobody had asked to see.
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
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

  // The office's work queue, counted from the list on screen. Shown on the unfiltered list only,
  // where it is the whole division; under a status filter it would be counting a subset.
  const queue = {
    decide: cases.filter((c) => nextStep(c) === "decide").length,
    pay: cases.filter((c) => nextStep(c) === "pay").length,
    paid: cases.filter((c) => nextStep(c) === "paid").length,
    waiting: cases.filter((c) => nextStep(c) === "waiting").length,
  };

  return (
    <main className="min-h-full px-design-4 py-design-5 sm:px-design-5 lg:py-design-6">
      {/* Redesign (2026-10-07), the admin portal's look. This device's notification switch moved
          into the account menu (StaffTopBar) and the language switch into the top bar, so the
          page opens on the division's work: what needs a decision, what is ready to pay. */}
      <div className="mx-auto flex max-w-5xl flex-col gap-design-5">
        <PageHeader
          title={t("title")}
          subtitle={
            dsDivision ? (
              // Named explicitly, so a DS officer is never in doubt about whose cases these are.
              <span className="inline-flex items-center gap-design-1">
                <MapPin aria-hidden="true" size={16} />
                {t("divisionLabel")}: <span className="font-semibold text-ink-primary">{dsDivision}</span>
              </span>
            ) : undefined
          }
        />

        {state.kind === "ready" && statusFilter === "" && cases.length > 0 && (
          <div
            className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border-subtle bg-border-subtle shadow-card sm:grid-cols-4"
            data-testid="ds-queue"
          >
            {(["decide", "pay", "waiting", "paid"] as const).map((k) => (
              <div key={k} className="flex flex-col-reverse justify-end gap-design-1 bg-surface-raised p-design-4">
                <span className="text-label text-ink-secondary">{t(`queue.${k}`)}</span>
                <span
                  className={`text-display font-semibold tabular-nums tracking-tight ${
                    (k === "decide" || k === "pay") && queue[k] > 0 ? "text-forest" : "text-ink-primary"
                  }`}
                >
                  {queue[k]}
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          role="group"
          aria-label={t("filterAria")}
          className="inline-flex max-w-full gap-0.5 self-start overflow-x-auto rounded-sm border border-border-subtle bg-surface-raised p-0.5 shadow-card"
        >
          {["", ...FILTER_STATUSES].map((s) => (
            <button
              key={s || "all"}
              type="button"
              onClick={() => setStatusFilter(s)}
              aria-pressed={statusFilter === s}
              className={`h-9 shrink-0 whitespace-nowrap rounded-[6px] px-design-3 text-label font-medium transition-colors duration-150 motion-reduce:transition-none ${
                statusFilter === s ? "bg-forest text-ink-on-dark" : "text-ink-secondary hover:bg-surface-base hover:text-ink-primary"
              }`}
            >
              {s ? tStatus(`statusLabels.${statusKey(s)}`) : t("filterAll")}
            </button>
          ))}
        </div>

        {state.kind === "loading" && (
          <div className="flex flex-col gap-design-3">
            <p role="status" aria-live="polite" className="text-caption text-ink-secondary">
              {t("loading")}
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-design-3 h-3 w-64" />
                <Skeleton className="mt-design-4 h-9 w-48" />
              </div>
            ))}
          </div>
        )}

        {state.kind === "failed" && (
          <div role="alert" className="flex flex-col gap-design-2 rounded-md border border-status-error/30 bg-status-error-pale px-design-4 py-design-3">
            <p className="text-label text-status-error">{t(failureKey(state.failure))}</p>
            {"status" in state.failure && (
              // The status and the backend's own code. An officer can ignore it; it is the first
              // thing anyone debugging needs, and it is what otherwise requires opening DevTools.
              <p className="font-staff-mono text-caption text-ink-secondary">
                {t("error.detail", {
                  status: state.failure.status,
                  code: state.failure.code || "—",
                })}
              </p>
            )}
            {isRetryable(state.failure) && (
              <button type="button" onClick={() => setReloadNonce((n) => n + 1)} className={`${buttonStyles.secondary} self-start`}>
                <ArrowClockwise aria-hidden="true" size={16} />
                {t("retry")}
              </button>
            )}
          </div>
        )}

        {state.kind === "ready" && cases.length === 0 && (
          <div className="flex flex-col items-center gap-design-3 rounded-md border border-border-subtle bg-surface-raised px-design-5 py-design-8 text-center shadow-card">
            <span className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-tint text-forest">
              <Tray aria-hidden="true" size={24} />
            </span>
            <p className="text-body text-ink-primary">{t("empty")}</p>
          </div>
        )}

        {state.kind === "ready" && cases.length > 0 && (
          <ul className="flex flex-col gap-design-3">
            {cases.map((c) => {
              const step = nextStep(c);
              const reported = formatDate(c.submitted_at, locale);
              const drawerOpen =
                evidenceFor === c.canonical_id ||
                bankFor === c.canonical_id ||
                decidingFor === c.canonical_id ||
                payingFor === c.canonical_id;
              return (
                <li
                  key={c.canonical_id}
                  id={`ds-case-${c.canonical_id}`}
                  className={`overflow-hidden rounded-md border bg-surface-raised shadow-card ${
                    focusRef === c.canonical_id ? "border-forest ring-4 ring-forest-pale" : "border-border-subtle"
                  }`}
                  data-testid="ds-case"
                >
                  <div className="flex flex-col gap-design-3 p-design-4 sm:p-design-5">
                    <div className="flex flex-wrap items-start justify-between gap-design-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-design-2">
                          <span className="font-staff-mono text-label font-semibold text-ink-primary">{c.canonical_id}</span>
                          <StatusBadge
                            status={c.status}
                            label={isTranslatedStatus(c.status) ? tStatus(`statusLabels.${statusKey(c.status)}`) : c.status}
                          />
                        </div>
                        {/* What happened and when, before anything about money. */}
                        <p className="mt-design-1 text-caption text-ink-secondary" data-testid="ds-case-incident">
                          {KNOWN_CATEGORIES.includes(c.damage_category) ? tCategory(c.damage_category) : c.damage_category}
                          {reported && (
                            <>
                              {" · "}
                              {t("submittedOn", { date: reported })}
                            </>
                          )}
                        </p>
                      </div>
                      {step && (
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-design-2 py-0.5 text-caption font-medium ${
                          step === "decide" || step === "pay" ? "bg-forest-pale text-forest" : "bg-surface-base text-ink-secondary"
                        }`}
                        data-testid="ds-next-step"
                      >
                        {step === "paid" && <CheckCircle aria-hidden="true" size={14} weight="fill" />}
                        {t(`queue.${step}`)}
                      </span>
                      )}
                    </div>

                    <p className="flex flex-wrap gap-x-design-4 gap-y-design-1 text-caption text-ink-secondary">
                      {/* A case with no household predates Epic 8 or is seeded research data
                          (migration 025). Saying so beats rendering an empty field. */}
                      <span>
                        {t("household")}:{" "}
                        <span className="font-staff-mono text-ink-primary">{c.household_ref ?? t("noHousehold")}</span>
                      </span>
                      {c.household_ref && (
                        <span>
                          {c.bank_account_last4
                            ? t("bankDetails.current", { last4: c.bank_account_last4 })
                            : t("bankDetails.none")}
                        </span>
                      )}
                    </p>

                    {(c.status === "Approved" || c.status === "Payment Processed") && (
                      // What the DS officer decides from: the AI-assisted estimate (decision support),
                      // the DWC recommendation, and -- once made -- the recorded final decision.
                      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-border-subtle bg-border-subtle sm:grid-cols-3">
                        <div className="bg-surface-base px-design-3 py-design-2">
                          <dt className="text-caption text-ink-secondary">{t("finalDecision.aiEstimate")}</dt>
                          <dd className="text-label font-semibold tabular-nums text-ink-primary">
                            {typeof c.ai_estimate?.amount_lkr === "number" ? `LKR ${c.ai_estimate.amount_lkr.toLocaleString()}` : "—"}
                          </dd>
                        </div>
                        <div className="bg-surface-base px-design-3 py-design-2">
                          <dt className="text-caption text-ink-secondary">{t("finalDecision.dwcAmount")}</dt>
                          <dd className="text-label font-semibold tabular-nums text-ink-primary">
                            {typeof c.approved_amount === "number" ? `LKR ${c.approved_amount.toLocaleString()}` : "—"}
                          </dd>
                        </div>
                        <div className="bg-surface-base px-design-3 py-design-2" data-testid="ds-final-amount">
                          <dt className="text-caption text-ink-secondary">{t("finalDecision.decided")}</dt>
                          <dd className="text-label font-semibold tabular-nums text-forest">
                            {typeof c.final_decision?.amount_lkr === "number" ? `LKR ${c.final_decision.amount_lkr.toLocaleString()}` : "—"}
                          </dd>
                        </div>
                      </dl>
                    )}

                    {decidedNotice === c.canonical_id && (
                      <p role="status" className="inline-flex items-center gap-design-1 text-caption font-medium text-forest">
                        <CheckCircle aria-hidden="true" size={14} weight="fill" />
                        {t("finalDecision.recorded")}
                      </p>
                    )}

                    {/* Payment is offered only once the final decision is recorded: the DWC
                        administrator approves, the DS office decides the amount, then pays. */}
                    {c.status === "Approved" && c.household_ref && !c.final_decision && !c.payment_authorized && (
                      <p className="text-caption text-ink-secondary">{t("finalDecision.requiredBeforePayment")}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-design-2">
                      {/* Step 1 for an approved case: the human final decision on the amount.
                          Revisable until payment is authorised. */}
                      {c.status === "Approved" && !c.payment_authorized && decidingFor !== c.canonical_id && (
                        <button
                          type="button"
                          onClick={() => {
                            setPayingFor(null);
                            setDecidingFor(c.canonical_id);
                          }}
                          className={c.final_decision ? buttonStyles.secondary : buttonStyles.primary}
                        >
                          <Gavel aria-hidden="true" size={16} />
                          {c.final_decision ? t("finalDecision.revise") : t("finalDecision.title")}
                        </button>
                      )}

                      {/* Step 2: payment. (A case already authorised can re-reveal the account number.) */}
                      {c.status === "Approved" && c.household_ref && (c.final_decision || c.payment_authorized) &&
                        payingFor !== c.canonical_id && (
                        <button
                          type="button"
                          onClick={() => {
                            setDecidingFor(null);
                            setPayingFor(c.canonical_id);
                          }}
                          className={buttonStyles.primary}
                        >
                          <Bank aria-hidden="true" size={16} />
                          {t("payment.title")}
                        </button>
                      )}

                      {/* The evidence the claim rests on. This screen authorises a real payment, so
                          the family, their words and the photographs have to be reachable from it. */}
                      <button
                        type="button"
                        onClick={() => setEvidenceFor(evidenceFor === c.canonical_id ? null : c.canonical_id)}
                        aria-expanded={evidenceFor === c.canonical_id}
                        className={buttonStyles.secondary}
                        data-testid="ds-evidence-toggle"
                      >
                        <Images aria-hidden="true" size={16} />
                        {t(evidenceFor === c.canonical_id ? "evidence.hide" : "evidence.show")}
                      </button>

                      {c.household_ref && bankFor !== c.canonical_id && (
                        <button
                          type="button"
                          onClick={() => {
                            setPayingFor(null);
                            setDecidingFor(null);
                            setBankFor(c.canonical_id);
                          }}
                          className={buttonStyles.quiet}
                        >
                          <CreditCard aria-hidden="true" size={16} />
                          {c.bank_account_last4 ? t("bankDetails.change") : t("bankDetails.record")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Whatever the officer opened — the evidence, the decision, the payment, the bank
                      details — sits in one tinted drawer under the card, so it reads as part of
                      this case and not as the start of the next one. */}
                  {drawerOpen && (
                    <div className="flex flex-col gap-design-3 border-t border-border-subtle bg-surface-base p-design-4 sm:p-design-5">
                      {evidenceFor === c.canonical_id && (
                        <>
                          {/* Who the claim belongs to: the names to read aloud at the counter, and
                              how to reach them. One case's details, fetched on opening. */}
                          {c.household_ref && <ClaimantDetails caseRef={c.canonical_id} density="compact" />}
                          {/* The family's own words (migration 040) belong with the photographs. */}
                          <div
                            className="rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card"
                            data-testid="ds-citizen-description"
                          >
                            <p className="text-label font-semibold text-ink-primary">{t("evidence.description")}</p>
                            <p className={`mt-design-2 max-w-[65ch] whitespace-pre-wrap text-body ${c.citizen_description ? "text-ink-primary" : "text-ink-secondary"}`}>
                              {c.citizen_description || t("evidence.noDescription")}
                            </p>
                          </div>
                          <PhotoGallery caseRef={c.canonical_id} />
                        </>
                      )}

                      {bankFor === c.canonical_id && c.household_ref && (
                        <DsBankDetailsPanel
                          householdRef={c.household_ref}
                          currentLast4={c.bank_account_last4 ?? null}
                          t={t}
                          onSaved={(last4) =>
                            setCases((prev) =>
                              prev.map((x) =>
                                x.household_ref === c.household_ref ? { ...x, bank_account_last4: last4 } : x,
                              ),
                            )
                          }
                          onClose={() => setBankFor(null)}
                        />
                      )}

                      {decidingFor === c.canonical_id && (
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
                      )}

                      {payingFor === c.canonical_id && (
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
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}

type NextStep = "decide" | "pay" | "paid" | "waiting";

/** What this office does next with a case, or null when nothing (a rejected claim). Mirrors the
 *  action buttons' own conditions. */
function nextStep(c: DsCase): NextStep | null {
  if (c.status === "Rejected") return null;
  if (c.status === "Payment Processed" || c.payment_authorized) return "paid";
  if (c.status === "Approved") return c.final_decision ? "pay" : "decide";
  return "waiting";
}
