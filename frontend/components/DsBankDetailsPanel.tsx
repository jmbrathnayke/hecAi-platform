"use client";
// Divisional Secretariat: record or correct a family's bank account.
//
// The office that pays is where an account already on file may be changed — a citizen can only ADD
// one they skipped, because whoever held their session could otherwise redirect the compensation.
// A written reason is required, the same floor as a transfer or a final decision, and the trail
// records that the account changed and why, never what it changed to.
import { useState } from "react";
import { setHouseholdBankDetails, type BankDetailsFailure } from "@/lib/dsCases";

interface Props {
  householdRef: string;
  /** The tail currently on file, or null when the family has given no account. */
  currentLast4: string | null;
  t: (key: string, values?: Record<string, string | number>) => string;
  onSaved: (last4: string | null) => void;
  onClose: () => void;
}

const MIN_REASON = 10;
const FIELD =
  "min-h-touch-target w-full rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none";

function failureKey(f: BankDetailsFailure): string {
  switch (f.reason) {
    case "not-found":
      return "bankDetails.error.notFound";
    case "reason-required":
      return "bankDetails.error.reasonRequired";
    case "invalid-bank":
      return "bankDetails.error.invalidBank";
    case "forbidden":
      return "bankDetails.error.notFound";
    case "network":
      return "bankDetails.error.network";
    default:
      return "bankDetails.error.server";
  }
}

export function DsBankDetailsPanel({ householdRef, currentLast4, t, onSaved, onClose }: Props) {
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedLast4, setSavedLast4] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (!accountNumber.trim()) {
      setError(t("bankDetails.error.invalidBank"));
      return;
    }
    if (reason.trim().length < MIN_REASON) {
      setError(t("bankDetails.error.reasonRequired"));
      return;
    }
    setSaving(true);
    const result = await setHouseholdBankDetails(
      householdRef,
      {
        account_number: accountNumber.trim(),
        bank_name: bankName.trim() || undefined,
        branch: branch.trim() || undefined,
        account_holder: accountHolder.trim() || undefined,
      },
      reason.trim(),
    );
    setSaving(false);
    if (result.ok) {
      setSavedLast4(result.last4);
      onSaved(result.last4);
      return;
    }
    setError(t(failureKey(result.failure)));
  }

  return (
    <section
      data-testid="ds-bank-details-panel"
      className="flex flex-col gap-design-3 rounded-md border border-forest p-design-4"
    >
      <h2 className="text-label font-semibold text-ink-primary">
        {t("bankDetails.title")} — {householdRef}
      </h2>

      <p className="text-caption text-ink-secondary">
        {currentLast4
          ? t("bankDetails.current", { last4: currentLast4 })
          : t("bankDetails.none")}
      </p>

      {savedLast4 !== null ? (
        <>
          <p role="status" className="rounded-md bg-forest-pale px-design-3 py-design-2 text-caption text-forest">
            {t("bankDetails.saved", { last4: savedLast4 ?? "" })}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="min-h-touch-target self-start text-label font-semibold text-ink-secondary"
          >
            {t("bankDetails.close")}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-design-3" noValidate>
          <p className="text-caption text-ink-secondary">{t("bankDetails.hint")}</p>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="ds-account-number" className="text-caption font-medium text-ink-primary">
              {t("bankDetails.accountNumber")}
            </label>
            <input
              id="ds-account-number"
              inputMode="numeric"
              autoComplete="off"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              className={FIELD}
            />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="ds-bank-name" className="text-caption font-medium text-ink-primary">
              {t("bankDetails.bankName")}
            </label>
            <input id="ds-bank-name" value={bankName} onChange={(e) => setBankName(e.target.value)} className={FIELD} />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="ds-branch" className="text-caption font-medium text-ink-primary">
              {t("bankDetails.branch")}
            </label>
            <input id="ds-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={FIELD} />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="ds-account-holder" className="text-caption font-medium text-ink-primary">
              {t("bankDetails.accountHolder")}
            </label>
            <input
              id="ds-account-holder"
              value={accountHolder}
              onChange={(e) => setAccountHolder(e.target.value)}
              className={FIELD}
            />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="ds-bank-reason" className="text-caption font-medium text-ink-primary">
              {t("bankDetails.reasonLabel")}
            </label>
            <textarea
              id="ds-bank-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={`${FIELD} py-design-2`}
            />
            <p className="text-caption text-ink-secondary">{t("bankDetails.reasonHint")}</p>
          </div>

          {error && (
            <p role="alert" className="text-caption text-status-error">
              {error}
            </p>
          )}

          <div className="flex gap-design-2">
            <button
              type="submit"
              disabled={saving}
              className="min-h-touch-target rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber disabled:opacity-60"
            >
              {saving ? t("bankDetails.saving") : t("bankDetails.save")}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="min-h-touch-target rounded-md border border-border-default px-design-4 text-label font-medium text-ink-secondary"
            >
              {t("bankDetails.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
