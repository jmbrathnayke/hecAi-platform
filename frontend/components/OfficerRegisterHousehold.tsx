"use client";

// Register a family in the field (migration 041). Shown on step 1 of the officer-assisted report
// when the NIC lookup finds no household: the families this report exists for often have no
// smartphone, so no account of their own to register with, and until now the officer could only
// send them away.
//
// The household is PROVISIONAL. The officer who registers it also files its claim, so the
// Divisional Secretariat must verify the family before payment (backend ds.py verify_household).
// That is why the officer confirms seeing the NIC card, why the registrant's name is required (the
// DS office needs someone to check), and why no bank details are taken here.
//
// PII: the NICs live in component state and go straight into one fetch body (lib/households.ts);
// nothing here is written to IndexedDB or storage. Online only: the server must derive the NIC
// digest, so there is no offline queue for a registration.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { registerHouseholdByOfficer, type OfficerRegisterFailure } from "@/lib/households";
import { isValidNIC, normaliseMobile } from "@/lib/validation";
import { touchButtonStyles, touchFieldStyles } from "@/components/admin/ui";

interface MemberRow {
  nic: string;
  full_name: string;
  relationship: string;
}

interface Props {
  /** The citizen's NIC and mobile, already entered and validated on step 1. */
  nic: string;
  mobile: string;
  /** The officer's assigned DS divisions (from the verified session). */
  divisions: string[];
  onRegistered: (householdRef: string) => void;
  onCancel: () => void;
}

function failureKey(f: OfficerRegisterFailure): string {
  switch (f.reason) {
    case "network":
      return "submit.registerOffline";
    case "division-not-assigned":
      return "submit.registerNoDivision";
    case "nic-taken":
      return f.scope === "registrant" ? "submit.registerNicTaken" : "submit.registerMemberTaken";
    case "duplicate-nic-in-form":
      return "submit.registerDuplicateNic";
    case "invalid-nic":
      return "submit.registerMemberNicError";
    case "no-session":
    case "forbidden":
      return "submit.sessionError";
    default:
      return "submit.registerFailed";
  }
}

export function OfficerRegisterHousehold({ nic, mobile, divisions, onRegistered, onCancel }: Props) {
  const t = useTranslations("officer");
  const [fullName, setFullName] = useState("");
  const [address, setAddress] = useState("");
  const [division, setDivision] = useState(divisions[0] ?? "");
  const [gn, setGn] = useState("");
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [sawCard, setSawCard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (divisions.length === 0) {
    return (
      <p role="alert" className="text-caption text-status-error" data-testid="officer-register-no-division">
        {t("submit.registerNoDivision")}
      </p>
    );
  }

  function updateMember(i: number, field: keyof MemberRow, value: string) {
    setMembers((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }

  async function handleSubmit() {
    if (busy) return;
    if (!fullName.trim() || !address.trim() || !division || !sawCard) {
      setError(t("submit.registerRequired"));
      return;
    }
    if (members.some((m) => !isValidNIC(m.nic.trim()))) {
      setError(t("submit.registerMemberNicError"));
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError(t("submit.registerOffline"));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await registerHouseholdByOfficer({
      nic: nic.trim(),
      full_name: fullName.trim(),
      ds_division: division,
      gn_division: gn.trim() || undefined,
      address: address.trim(),
      members: members.map((m) => ({
        nic: m.nic.trim(),
        full_name: m.full_name.trim() || undefined,
        relationship: m.relationship.trim() || undefined,
      })),
      contact_mobile: normaliseMobile(mobile) ?? undefined,
    });
    setBusy(false);
    if (result.ok) onRegistered(result.householdRef);
    else setError(t(failureKey(result.failure)));
  }

  return (
    <section
      className="space-y-design-4 rounded-md border border-border-subtle bg-surface-raised p-design-4"
      aria-labelledby="officer-register-title"
      data-testid="officer-register-household"
    >
      <div className="space-y-design-1">
        <h2 id="officer-register-title" className="text-headline text-ink-primary">
          {t("submit.registerTitle")}
        </h2>
        <p className="text-caption text-ink-secondary">{t("submit.registerHint")}</p>
      </div>

      <div className="flex flex-col gap-design-2">
        <label htmlFor="reg-name" className="text-label font-medium text-ink-primary">
          {t("submit.registerName")}
        </label>
        <input id="reg-name" type="text" autoComplete="off" value={fullName}
          onChange={(e) => setFullName(e.target.value)} className={touchFieldStyles} />
      </div>

      <div className="flex flex-col gap-design-2">
        <label htmlFor="reg-address" className="text-label font-medium text-ink-primary">
          {t("submit.registerAddress")}
        </label>
        <textarea id="reg-address" rows={2} value={address} maxLength={300}
          onChange={(e) => setAddress(e.target.value)} className={`${touchFieldStyles} py-design-2`} />
      </div>

      <div className="flex flex-col gap-design-2">
        <label htmlFor="reg-division" className="text-label font-medium text-ink-primary">
          {t("submit.registerDivision")}
        </label>
        {divisions.length === 1 ? (
          <p id="reg-division" className="text-body text-ink-primary">{division}</p>
        ) : (
          <select id="reg-division" value={division} onChange={(e) => setDivision(e.target.value)}
            className={touchFieldStyles}>
            {divisions.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-col gap-design-2">
        <label htmlFor="reg-gn" className="text-label font-medium text-ink-primary">
          {t("submit.registerGn")}
        </label>
        <input id="reg-gn" type="text" autoComplete="off" value={gn}
          onChange={(e) => setGn(e.target.value)} className={touchFieldStyles} />
      </div>

      <fieldset className="space-y-design-3">
        <legend className="text-label font-medium text-ink-primary">{t("submit.registerMembers")}</legend>
        {members.map((m, i) => (
          <div key={i} className="space-y-design-2 rounded-sm border border-border-subtle p-design-3"
            data-testid="officer-register-member">
            <input aria-label={t("submit.registerMemberNic")} placeholder={t("submit.registerMemberNic")}
              type="text" autoComplete="off" value={m.nic}
              onChange={(e) => updateMember(i, "nic", e.target.value)} className={touchFieldStyles} />
            <input aria-label={t("submit.registerMemberName")} placeholder={t("submit.registerMemberName")}
              type="text" autoComplete="off" value={m.full_name}
              onChange={(e) => updateMember(i, "full_name", e.target.value)} className={touchFieldStyles} />
            <input aria-label={t("submit.registerMemberRelationship")}
              placeholder={t("submit.registerMemberRelationship")} type="text" autoComplete="off"
              value={m.relationship} onChange={(e) => updateMember(i, "relationship", e.target.value)}
              className={touchFieldStyles} />
            <button type="button" className={touchButtonStyles.quiet}
              onClick={() => setMembers((rows) => rows.filter((_, j) => j !== i))}>
              {t("submit.registerRemoveMember", { number: i + 1 })}
            </button>
          </div>
        ))}
        <button type="button" className={touchButtonStyles.secondary}
          onClick={() => setMembers((rows) => [...rows, { nic: "", full_name: "", relationship: "" }])}>
          {t("submit.registerAddMember")}
        </button>
      </fieldset>

      <label className="flex min-h-touch-target items-center gap-design-3 text-label text-ink-primary">
        <input type="checkbox" checked={sawCard} onChange={(e) => setSawCard(e.target.checked)}
          className="h-5 w-5 accent-forest" />
        {t("submit.registerConfirm")}
      </label>

      {error && (
        <p role="alert" className="text-caption text-status-error">{error}</p>
      )}

      <div className="space-y-design-2">
        <button type="button" disabled={busy} onClick={() => void handleSubmit()}
          className={touchButtonStyles.primary}>
          {busy ? t("submit.submitting") : t("submit.registerSubmit")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className={`${touchButtonStyles.secondary} w-full`}>
          {t("submit.registerCancel")}
        </button>
      </div>
    </section>
  );
}
