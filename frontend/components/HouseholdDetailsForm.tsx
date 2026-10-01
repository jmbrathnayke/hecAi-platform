"use client";
// The citizen's own household details, editable: address, GN division, notification email, and
// bank details only while none are on file (PATCH /households/me). District, division and family
// members are registration facts the DS office changes, so they are not offered here at all.
//
// Like registration, the account number lives in component state only and is never persisted
// client-side (lib/households.ts PII note).
import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateMyHousehold, type Household, type HouseholdChanges, type UpdateFailure } from "@/lib/households";
import { formatMobile, normaliseMobile } from "@/lib/validation";

const FIELD =
  "min-h-touch-target w-full rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none";

function failureKey(failure: UpdateFailure): string {
  switch (failure.reason) {
    case "invalid-address":
      return "addressRequired";
    case "invalid-email":
      return "emailInvalid";
    case "invalid-mobile":
      return "mobileInvalid";
    case "invalid-bank":
      return "bankInvalid";
    case "bank-locked":
      return "bankAlreadyOnFile";
    default:
      return "saveError";
  }
}

export function HouseholdDetailsForm({
  household,
  onSaved,
  onCancel,
  onSessionEnded,
}: {
  household: Household;
  onSaved: (updated: Household) => void;
  onCancel: () => void;
  onSessionEnded: () => void;
}) {
  const t = useTranslations("profile");
  const registrantName = household.members.find((m) => m.is_registrant)?.full_name ?? "";

  const [address, setAddress] = useState(household.address ?? "");
  const [gnDivision, setGnDivision] = useState(household.gn_division ?? "");
  const [contactEmail, setContactEmail] = useState(household.contact_email ?? "");
  const [mobile, setMobile] = useState(household.contact_mobile ? formatMobile(household.contact_mobile) : "");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [accountHolder, setAccountHolder] = useState(registrantName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canAddBank = !household.bank_account_last4;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);

    if (!address.trim()) {
      setError(t("addressRequired"));
      return;
    }
    const email = contactEmail.trim();
    if (email && (!email.includes("@") || /\s/.test(email))) {
      setError(t("emailInvalid"));
      return;
    }
    const canonicalMobile = normaliseMobile(mobile);
    if (canonicalMobile === null) {
      setError(t("mobileInvalid"));
      return;
    }

    // Only what actually changed: an unchanged field sent back would still be a no-op server-side,
    // but a request with nothing in it is clearer as no request at all.
    const changes: HouseholdChanges = {};
    if (address.trim() !== (household.address ?? "")) changes.address = address.trim();
    if (gnDivision.trim() !== (household.gn_division ?? "")) changes.gn_division = gnDivision.trim();
    if (email !== (household.contact_email ?? "")) changes.contact_email = email;
    if (canonicalMobile !== (household.contact_mobile ?? "")) changes.contact_mobile = canonicalMobile;
    if (canAddBank && accountNumber.trim()) {
      changes.bank = {
        account_number: accountNumber.trim(),
        bank_name: bankName.trim() || undefined,
        branch: branch.trim() || undefined,
        account_holder: accountHolder.trim() || undefined,
      };
    }
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }

    setSaving(true);
    const result = await updateMyHousehold(changes);
    setSaving(false);
    if (result.ok) {
      onSaved(result.household);
      return;
    }
    if (result.failure.reason === "no-session") {
      onSessionEnded();
      return;
    }
    setError(t(failureKey(result.failure)));
  }

  return (
    <form data-testid="profile-edit-form" onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-design-4" noValidate>
      <p className="rounded-md bg-surface-base px-design-3 py-design-2 text-caption text-ink-secondary">
        {t("lockedNote")}
      </p>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="edit-address" className="text-label font-medium text-ink-primary">
          {t("address")}
        </label>
        <textarea
          id="edit-address"
          rows={3}
          maxLength={300}
          autoComplete="street-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={`${FIELD} py-design-2`}
        />
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="edit-gn" className="text-label font-medium text-ink-primary">
          {t("gnDivision")}
        </label>
        <input id="edit-gn" value={gnDivision} onChange={(e) => setGnDivision(e.target.value)} className={FIELD} />
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="edit-email" className="text-label font-medium text-ink-primary">
          {t("contactEmail")}
        </label>
        <input
          id="edit-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          className={FIELD}
        />
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="edit-mobile" className="text-label font-medium text-ink-primary">
          {t("contactMobile")}
        </label>
        <input
          id="edit-mobile"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="07X XXX XXXX"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          className={FIELD}
        />
        <p className="text-caption text-ink-secondary">{t("contactMobileHint")}</p>
      </div>

      {canAddBank ? (
        <fieldset className="flex flex-col gap-design-3 rounded-md border border-border-subtle p-design-4">
          <legend className="px-design-1 text-label font-semibold text-ink-primary">{t("addBankTitle")}</legend>
          <p className="text-caption text-ink-secondary">{t("addBankHint")}</p>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="edit-account" className="text-label font-medium text-ink-primary">
              {t("accountNumber")}
            </label>
            <input
              id="edit-account"
              inputMode="numeric"
              autoComplete="off"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="edit-bank" className="text-label font-medium text-ink-primary">
              {t("bankName")}
            </label>
            <input id="edit-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} className={FIELD} />
          </div>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="edit-branch" className="text-label font-medium text-ink-primary">
              {t("branch")}
            </label>
            <input id="edit-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={FIELD} />
          </div>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="edit-holder" className="text-label font-medium text-ink-primary">
              {t("accountHolder")}
            </label>
            <input
              id="edit-holder"
              value={accountHolder}
              onChange={(e) => setAccountHolder(e.target.value)}
              className={FIELD}
            />
          </div>
        </fieldset>
      ) : (
        <div className="rounded-md border border-border-subtle p-design-4">
          <p className="text-label font-medium text-ink-primary">
            {t("bankAccount")}: {t("bankAccountValue", { last4: household.bank_account_last4 ?? "" })}
          </p>
          <p className="mt-design-1 text-caption text-ink-secondary">{t("bankLocked")}</p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-design-2 sm:flex-row">
        <button
          type="submit"
          disabled={saving}
          className="min-h-primary-btn flex-1 rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber disabled:opacity-60"
        >
          {saving ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-touch-target flex-1 rounded-md border border-border-default px-design-4 text-label font-medium text-ink-secondary"
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
