"use client";
// Household registration (Story 8.2, FR-10.1/10.3). One person per family registers; the NICs of
// the declared members are occupied by that registration, so no second household can claim them.
//
// WHY THIS IS ONE ROUTE WITH INTERNAL STEPS, unlike the incident form's four routes.
// The incident form persists each step to IndexedDB so a villager can complete it over hours with
// no signal — and it AES-GCM encrypts the NIC first (NFR-3.1). Registration cannot work offline at
// all (the identity digest is derived server-side with a pepper the browser must never hold), so
// there is nothing to gain from persisting, and a great deal to lose: staging plaintext NICs for
// every declared family member in sessionStorage or IndexedDB would create exactly the PII store
// the schema is designed to avoid. Holding them in component state means they exist only in
// memory, travel once over TLS, and are gone on unmount.
//
// EXPERIENCE.md originally specified four routes for this flow; it was updated to match this
// as-built decision on 2026-08-26 with the reasoning above.
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { DistrictPicker, type DistrictSelection } from "@/components/DistrictPicker";
import { isValidNIC } from "@/lib/validation";
import { registerHousehold, type RegisterFailure } from "@/lib/households";
import {
  HouseholdConflictScreen,
  type ConflictVariant,
} from "@/components/HouseholdConflictScreen";

interface MemberDraft {
  key: number;
  nic: string;
  fullName: string;
  relationship: string;
}

let nextKey = 1;
function blankMember(): MemberDraft {
  return { key: nextKey++, nic: "", fullName: "", relationship: "" };
}

/** Which message explains this failure. Kept beside the union so a new reason cannot be forgotten. */
function failureKey(f: RegisterFailure): string {
  switch (f.reason) {
    case "already-registered":
      return "error.alreadyRegistered";
    case "nic-taken":
      return f.scope === "registrant" ? "error.nicTakenRegistrant" : "error.nicTakenMember";
    case "invalid-nic":
      return "error.invalidNic";
    case "invalid-division":
      return "error.invalidDivision";
    case "duplicate-nic-in-form":
      return "error.duplicateInForm";
    case "invalid-bank":
      return "error.invalidBank";
    case "invalid-form":
      return "error.invalidForm";
    case "no-session":
      return "error.noSession";
    case "forbidden":
      return "error.forbidden";
    case "config":
      return "error.config";
    case "network":
      return "error.network";
    default:
      return "error.server";
  }
}

/** Retry is offered only where it can help. Re-posting cannot free an occupied NIC. */
function isRetryable(f: RegisterFailure): boolean {
  return f.reason === "network" || f.reason === "server";
}

function householdRefOf(f: RegisterFailure): string | null {
  if (f.reason === "already-registered") return f.householdRef;
  if (f.reason === "nic-taken" && f.scope === "registrant") return f.householdRef;
  return null;
}

/**
 * Which failures replace the whole form, and which merely annotate it (Story 8.3).
 *
 * A clash on the REGISTRANT'S OWN NIC means this family is already in the registry. There is
 * nothing on the form to correct, so leaving the half-filled form on screen under a red line
 * would be offering a fix that does not exist — and, per EXPERIENCE.md, would read as an
 * accusation to someone who has done nothing wrong. It takes over the screen.
 *
 * A clash on a DECLARED MEMBER is the opposite: the citizen can remove that person and carry on,
 * so it stays inline where the form they need to edit still is.
 *
 * Returns null when there is no reference to show. A takeover screen whose whole purpose is to
 * give the citizen a number to quote is worse than useless with the number missing.
 */
function takeoverVariant(f: RegisterFailure): ConflictVariant | null {
  if (!householdRefOf(f)) return null;
  if (f.reason === "already-registered") return "own-account";
  if (f.reason === "nic-taken" && f.scope === "registrant") return "family-registered";
  return null;
}

export default function RegisterHouseholdPage() {
  const t = useTranslations("register");
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [nic, setNic] = useState("");
  const [fullName, setFullName] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [area, setArea] = useState<DistrictSelection | null>(null);
  const [gnDivision, setGnDivision] = useState("");
  // Step 4, optional (FR-10.4). Held in component state only, like the NICs — never written
  // to any browser storage. Sent over TLS and encrypted server-side.
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<RegisterFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ householdRef: string; memberCount: number } | null>(null);

  const steps = [t("steps.registrant"), t("steps.family"), t("steps.area"), t("steps.bank")];
  const LAST_STEP = 3;

  function goNext() {
    setFieldError(null);
    if (step === 0) {
      if (!isValidNIC(nic)) {
        setFieldError(t("step1.nicError"));
        return;
      }
    }
    if (step === 2 && !area) {
      setFieldError(t("step3.areaError"));
      return;
    }
    if (step === 1) {
      // Every row the user actually filled in must be a valid NIC. Blank rows are ignored rather
      // than rejected — an empty row is someone who changed their mind, not an error.
      const filled = members.filter((m) => m.nic.trim() !== "");
      if (filled.some((m) => !isValidNIC(m.nic))) {
        setFieldError(t("step2.nicError"));
        return;
      }
      const all = [nic, ...filled.map((m) => m.nic)].map((n) => n.trim().toUpperCase());
      if (new Set(all).size !== all.length) {
        setFieldError(t("step2.duplicateError"));
        return;
      }
    }
    setStep((s) => s + 1);
  }

  async function handleSubmit() {
    if (submitting) return;
    setFieldError(null);
    setFailure(null);

    if (!area) {
      setFieldError(t("step3.areaError"));
      return;
    }

    setSubmitting(true);
    const result = await registerHousehold({
      nic: nic.trim(),
      full_name: fullName.trim() || undefined,
      district: area.district,
      ds_division: area.dsDivision,
      gn_division: gnDivision.trim() || undefined,
      // Omitted entirely when the citizen skipped the step — an empty object would be a 400.
      bank: accountNumber.trim()
        ? {
            account_number: accountNumber.trim(),
            bank_name: bankName.trim() || undefined,
            branch: branch.trim() || undefined,
            account_holder: fullName.trim() || undefined,
          }
        : undefined,
      members: members
        .filter((m) => m.nic.trim() !== "")
        .map((m) => ({
          nic: m.nic.trim(),
          full_name: m.fullName.trim() || undefined,
          relationship: m.relationship.trim() || undefined,
        })),
    });
    setSubmitting(false);

    if (result.ok) {
      setDone({ householdRef: result.householdRef, memberCount: result.memberCount });
      return;
    }
    setFailure(result.failure);
  }

  // -------------------------------------------------- already registered (Story 8.3)
  // Checked before the success branch and before the form: when the family is already in the
  // registry this is the only thing on screen.
  const takeover = failure ? takeoverVariant(failure) : null;
  if (failure && takeover) {
    return (
      <HouseholdConflictScreen
        variant={takeover}
        householdRef={householdRefOf(failure) ?? ""}
        t={t}
      />
    );
  }

  // ---------------------------------------------------------------- success
  if (done) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
        <div
          className="rounded-lg bg-forest p-design-6 text-center"
          role="status"
          aria-live="polite"
          data-testid="registration-receipt"
        >
          <p className="text-label text-ink-on-dark opacity-90">{t("done.label")}</p>
          <p className="mt-design-2 text-display font-bold text-ink-on-dark">{done.householdRef}</p>
        </div>
        <p className="text-body text-ink-primary">{t("done.body")}</p>
        <button
          type="button"
          onClick={() => router.push("/report")}
          className="min-h-touch-target rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
        >
          {t("done.reportIncident")}
        </button>
      </main>
    );
  }

  // ---------------------------------------------------------------- form
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
      <StepIndicator steps={steps} currentStep={step} />

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t(`step${step + 1}.title`)}</h1>
        <p className="mt-design-2 text-body text-ink-secondary">{t(`step${step + 1}.intro`)}</p>
      </header>

      {step === 0 && (
        <div className="flex flex-col gap-design-4">
          <div className="flex flex-col gap-design-1">
            <label htmlFor="registrant-nic" className="text-label font-medium text-ink-primary">
              {t("step1.nic")}
            </label>
            <input
              id="registrant-nic"
              inputMode="numeric"
              value={nic}
              onChange={(e) => setNic(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="registrant-name" className="text-label font-medium text-ink-primary">
              {t("step1.fullName")}
            </label>
            <input
              id="registrant-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-design-4">
          {/* Stated as a reason, not a rule (EXPERIENCE.md). Someone being told their relatives
              are blocked deserves to know why before it happens to them. */}
          <p className="rounded-md bg-surface-tint p-design-4 text-body text-ink-secondary">
            {t("step2.why")}
          </p>

          {members.map((m, i) => (
            <fieldset key={m.key} className="flex flex-col gap-design-2 rounded-md border border-border-default p-design-3">
              <legend className="px-design-1 text-caption text-ink-secondary">
                {t("step2.memberN", { n: i + 1 })}
              </legend>
              <label htmlFor={`member-nic-${m.key}`} className="text-label font-medium text-ink-primary">
                {t("step2.nic")}
              </label>
              <input
                id={`member-nic-${m.key}`}
                inputMode="numeric"
                value={m.nic}
                onChange={(e) =>
                  setMembers((prev) =>
                    prev.map((x) => (x.key === m.key ? { ...x, nic: e.target.value } : x)),
                  )
                }
                className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
              />
              <label htmlFor={`member-name-${m.key}`} className="text-label font-medium text-ink-primary">
                {t("step2.fullName")}
              </label>
              <input
                id={`member-name-${m.key}`}
                value={m.fullName}
                onChange={(e) =>
                  setMembers((prev) =>
                    prev.map((x) => (x.key === m.key ? { ...x, fullName: e.target.value } : x)),
                  )
                }
                className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
              />
              <button
                type="button"
                onClick={() => setMembers((prev) => prev.filter((x) => x.key !== m.key))}
                className="min-h-touch-target self-start text-label font-semibold text-status-error"
              >
                {t("step2.remove")}
              </button>
            </fieldset>
          ))}

          <button
            type="button"
            onClick={() => setMembers((prev) => [...prev, blankMember()])}
            className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
          >
            {t("step2.addMember")}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-design-4">
          <DistrictPicker
            value={area}
            onChange={setArea}
            districtLabel={t("step3.districtLabel")}
            districtPlaceholder={t("step3.districtPlaceholder")}
            dsDivisionLabel={t("step3.dsDivisionLabel")}
            dsDivisionPlaceholder={t("step3.dsDivisionPlaceholder")}
          />
          <div className="flex flex-col gap-design-1">
            <label htmlFor="gn-division" className="text-label font-medium text-ink-primary">
              {t("step3.gnLabel")}
            </label>
            <input
              id="gn-division"
              value={gnDivision}
              onChange={(e) => setGnDivision(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-design-4">
          {/* Optional, and said so plainly. A citizen without an account, or who does not have
              the number to hand at a village registration desk, must not be stuck here. */}
          <p className="rounded-md bg-surface-tint p-design-4 text-body text-ink-secondary">
            {t("step4.optional")}
          </p>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="bank-account" className="text-label font-medium text-ink-primary">
              {t("step4.accountNumber")}
            </label>
            <input
              id="bank-account"
              inputMode="numeric"
              autoComplete="off"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="bank-name" className="text-label font-medium text-ink-primary">
              {t("step4.bankName")}
            </label>
            <input
              id="bank-name"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>

          <div className="flex flex-col gap-design-1">
            <label htmlFor="bank-branch" className="text-label font-medium text-ink-primary">
              {t("step4.branch")}
            </label>
            <input
              id="bank-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body text-ink-primary"
            />
          </div>
        </div>
      )}

      {fieldError && (
        <p role="alert" className="text-body text-status-error">
          {fieldError}
        </p>
      )}

      {failure && (
        <div role="alert" className="flex flex-col gap-design-2">
          <p className="text-body text-status-error">{t(failureKey(failure))}</p>
          {householdRefOf(failure) && (
            <p className="text-label font-semibold text-ink-primary" data-testid="conflict-household-ref">
              {householdRefOf(failure)}
            </p>
          )}
          {isRetryable(failure) && (
            <button
              type="button"
              onClick={handleSubmit}
              className="min-h-touch-target self-start rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
            >
              {t("retry")}
            </button>
          )}
        </div>
      )}

      <div className="flex gap-design-3">
        {step > 0 && (
          <button
            type="button"
            onClick={() => {
              setFieldError(null);
              setFailure(null);
              setStep((s) => s - 1);
            }}
            className="min-h-touch-target flex-1 rounded-md border border-border-default px-design-4 text-label font-semibold text-ink-primary"
          >
            {t("back")}
          </button>
        )}
        {step < LAST_STEP ? (
          <button
            type="button"
            onClick={goNext}
            className="min-h-touch-target flex-1 rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
          >
            {t("next")}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="min-h-touch-target flex-1 rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber disabled:opacity-60"
          >
            {submitting ? t("submitting") : t("submit")}
          </button>
        )}
      </div>
    </main>
  );
}
