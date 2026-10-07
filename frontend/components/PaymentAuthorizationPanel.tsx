"use client";
// Divisional Secretariat payment authorisation (Story 8.6, FR-10.4).
//
// THE ONLY PLACE IN THE UI A FULL BANK ACCOUNT NUMBER IS EVER SHOWN. Everywhere else — the case
// list, the admin dashboard, the officer app, every export and the PDF report — shows the last
// four digits and nothing more.
//
// The number is not fetched on mount. It arrives only in response to a deliberate click, because
// the request that returns it is the same request that authorises the payment and writes the
// audit row. Rendering it on page load would mean a reveal every time someone opened a case,
// including by accident, and an audit trail full of accesses nobody intended.
import { useState } from "react";
import { authorizePayment, type PaymentAuthorization, type PaymentFailure } from "@/lib/dsCases";
import { buttonStyles } from "@/components/admin/ui";

interface Props {
  canonicalId: string;
  t: (key: string, values?: Record<string, string | number>) => string;
  onClose: () => void;
  /** Offered when the family has given no account: the DS office records one (Epic 8 gap). */
  onRecordBankDetails?: () => void;
}

/** Which message explains this refusal. Each has a different person who must act on it. */
function failureKey(f: PaymentFailure): string {
  switch (f.reason) {
    case "not-found":
      return "payment.error.notFound";
    case "not-approved":
      return "payment.error.notApproved";
    case "final-decision-required":
      return "payment.error.finalDecisionRequired";
    case "no-household":
      return "payment.error.noHousehold";
    case "no-bank-details":
      return "payment.error.noBankDetails";
    case "unreadable":
      return "payment.error.unreadable";
    case "forbidden":
      return "payment.error.notFound";
    case "network":
      return "payment.error.network";
    default:
      return "payment.error.server";
  }
}

export function PaymentAuthorizationPanel({ canonicalId, t, onClose, onRecordBankDetails }: Props) {
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<PaymentAuthorization | null>(null);
  const [failure, setFailure] = useState<PaymentFailure | null>(null);

  async function reveal() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await authorizePayment(canonicalId);
    setBusy(false);
    if (result.ok) setAuth(result.authorization);
    else setFailure(result.failure);
  }

  return (
    <section
      className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card sm:p-design-5"
      data-testid="payment-panel"
    >
      <h2 className="text-label font-semibold text-ink-primary">
        {t("payment.title")}{" "}
        <span className="ml-design-1 font-staff-mono text-caption font-medium text-ink-secondary">{canonicalId}</span>
      </h2>

      {!auth && (
        <>
          {/* Said before the click, not after. The officer should know the reveal is recorded
              while they can still decide not to. */}
          <p className="text-caption text-ink-secondary">{t("payment.warning")}</p>
          <button
            type="button"
            onClick={reveal}
            disabled={busy}
            className={`${buttonStyles.primary} self-start`}
          >
            {busy ? t("payment.revealing") : t("payment.reveal")}
          </button>
        </>
      )}

      {failure && (
        <p role="alert" className="rounded-sm bg-status-error-pale px-design-3 py-design-2 text-label text-status-error">
          {t(failureKey(failure))}
        </p>
      )}

      {/* The one refusal this screen can resolve itself: the family gave no account, and this is
          the office that records one. */}
      {failure?.reason === "no-bank-details" && onRecordBankDetails && (
        <button
          type="button"
          onClick={onRecordBankDetails}
          className={`${buttonStyles.secondary} self-start`}
        >
          {t("bankDetails.record")}
        </button>
      )}

      {auth && (
        <dl className="grid grid-cols-1 gap-x-design-4 gap-y-design-3 rounded-sm border border-border-subtle bg-surface-base p-design-4 sm:grid-cols-2" data-testid="bank-details">
          <div>
            <dt className="text-caption text-ink-secondary">{t("payment.accountNumber")}</dt>
            <dd className="font-staff-mono text-headline tracking-wide text-ink-primary">
              {auth.bank_details.account_number}
            </dd>
          </div>
          {auth.bank_details.bank_name && (
            <div>
              <dt className="text-caption text-ink-secondary">{t("payment.bankName")}</dt>
              <dd className="text-body text-ink-primary">{auth.bank_details.bank_name}</dd>
            </div>
          )}
          {auth.bank_details.branch && (
            <div>
              <dt className="text-caption text-ink-secondary">{t("payment.branch")}</dt>
              <dd className="text-body text-ink-primary">{auth.bank_details.branch}</dd>
            </div>
          )}
          {auth.bank_details.account_holder && (
            <div>
              <dt className="text-caption text-ink-secondary">{t("payment.accountHolder")}</dt>
              <dd className="text-body text-ink-primary">{auth.bank_details.account_holder}</dd>
            </div>
          )}
          <div>
            <dt className="text-caption text-ink-secondary">{t("payment.finalAmount")}</dt>
            <dd className="text-body font-semibold text-ink-primary">
              {auth.amount_lkr === null ? "—" : `Rs. ${auth.amount_lkr.toLocaleString()}`}
            </dd>
          </div>
        </dl>
      )}

      <button
        type="button"
        onClick={onClose}
        className={`${buttonStyles.quiet} self-start`}
      >
        {t("payment.close")}
      </button>
    </section>
  );
}
