"use client";

// Who submitted the case: the registered household behind it (backend case_claimant.py, 2026-10-07).
//
// Shown on the officer's case screen, the administrator's case file and the Divisional
// Secretariat's payment card. Until now each of them showed the damage, the photographs and the
// family's own words, and nothing about the family: the officer who had to visit had no address
// and no number to call, and the DS office paying the claim had no names to read aloud.
//
// ONE CASE AT A TIME, AND EVERY READ IS AUDITED. The fetch happens only when this component
// mounts for one case, so no list ever loads a family's details in bulk. The server writes
// `case_claimant_viewed` for each read. There is no NIC to show: only its digest is stored.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { fetchCaseClaimant, type ClaimantFailure, type ClaimantHousehold } from "@/lib/caseClaimant";
import { verifyHousehold } from "@/lib/dsCases";
import { formatMobile } from "@/lib/validation";

type State =
  | { kind: "loading" }
  | { kind: "ready"; household: ClaimantHousehold | null }
  | { kind: "failed"; failure: ClaimantFailure };

function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(locale);
}

function Row({
  label,
  children,
  testId,
  compact = false,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-design-1" data-testid={testId}>
      <dt className="text-caption text-ink-secondary">{label}</dt>
      <dd className={`break-words text-ink-primary ${compact ? "text-label" : "text-body"}`}>{children}</dd>
    </div>
  );
}

// The written-reason floor the backend enforces (domain/validation.py MIN_REASON_LENGTH).
const MIN_NOTE_LENGTH = 10;

/** The DS office's check of a household a field officer registered (migration 041). */
function VerifyHouseholdForm({ householdRef, onVerified }: { householdRef: string; onVerified: () => void }) {
  const t = useTranslations("claimant");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (note.trim().length < MIN_NOTE_LENGTH) {
      setError(t("verifyNoteRequired", { min: MIN_NOTE_LENGTH }));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await verifyHousehold(householdRef, note.trim());
    setBusy(false);
    if (res.ok) onVerified();
    else setError(res.failure === "note-required"
      ? t("verifyNoteRequired", { min: MIN_NOTE_LENGTH })
      : t("verifyFailed"));
  }

  return (
    <div className="space-y-design-2" data-testid="claimant-verify">
      <h3 className="text-label font-semibold text-ink-primary">{t("verifyTitle")}</h3>
      <p className="text-caption text-ink-secondary">{t("verifyHint")}</p>
      <label htmlFor={`verify-note-${householdRef}`} className="sr-only">{t("verifyNote")}</label>
      <textarea
        id={`verify-note-${householdRef}`}
        rows={2}
        value={note}
        placeholder={t("verifyNote")}
        onChange={(e) => setNote(e.target.value)}
        className="w-full rounded-md border border-border-default bg-surface-raised p-design-2 text-label text-ink-primary"
      />
      {error && <p role="alert" className="text-caption text-status-error">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        className="min-h-touch-target rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-50"
      >
        {t("verifySubmit")}
      </button>
    </div>
  );
}

export function ClaimantDetails({
  caseRef,
  density = "default",
  canVerify = false,
}: {
  caseRef: string;
  /** `compact` matches the admin case rail's smaller section type (admin redesign, 2026-10-07). */
  density?: "default" | "compact";
  /** The Divisional Secretariat may verify an officer-registered household here (migration 041). */
  canVerify?: boolean;
}) {
  const compact = density === "compact";
  const t = useTranslations("claimant");
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const res = await fetchCaseClaimant(caseRef);
    setState(res.ok ? { kind: "ready", household: res.household } : { kind: "failed", failure: res.failure });
  }, [caseRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const notRecorded = <span className="text-ink-disabled">{t("notRecorded")}</span>;

  return (
    <section
      className={`space-y-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4 ${compact ? "shadow-card" : ""}`}
      data-testid="claimant-details"
      aria-labelledby={`claimant-title-${caseRef}`}
    >
      <h2 id={`claimant-title-${caseRef}`} className={compact ? "text-label font-semibold text-ink-primary" : "text-headline text-ink-primary"}>
        {t("title")}
      </h2>

      {state.kind === "loading" && (
        <p className="text-body text-ink-secondary" data-testid="claimant-loading">{t("loading")}</p>
      )}

      {state.kind === "failed" && (
        <div className="space-y-design-2" data-testid="claimant-error">
          <p role="alert" className="text-body text-status-error">
            {t(state.failure.reason === "signed-out" || state.failure.reason === "no-session"
              ? "error.signedOut"
              : state.failure.reason === "not-found"
                ? "error.notFound"
                : "error.generic")}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-touch-target rounded-md border border-border-default px-design-3 text-label font-medium text-ink-secondary"
          >
            {t("retry")}
          </button>
        </div>
      )}

      {state.kind === "ready" && state.household === null && (
        <p className="text-body text-ink-secondary" data-testid="claimant-none">{t("noHousehold")}</p>
      )}

      {state.kind === "ready" && state.household !== null && (() => {
        const h = state.household;
        const registrant = h.members.find((m) => m.is_registrant);
        const others = h.members.filter((m) => !m.is_registrant);
        const registered = formatDate(h.registered_at, locale);
        const verifiedOn = formatDate(h.verified_at ?? null, locale);
        return (
          <>
            {h.provisional && (
              <div
                className="space-y-design-3 rounded-md border border-status-warning bg-surface-base p-design-3"
                data-testid="claimant-provisional"
              >
                <p className="text-label text-ink-primary">{t("provisional")}</p>
                {canVerify && <VerifyHouseholdForm householdRef={h.household_ref} onVerified={() => void load()} />}
              </div>
            )}
            {h.registered_by_officer && !h.provisional && verifiedOn && (
              <p className="text-caption text-ink-secondary" data-testid="claimant-verified">
                {t("verifiedOn", { date: verifiedOn })}
              </p>
            )}
            <div>
              <p className="text-caption text-ink-secondary">{t("registrant")}</p>
              <p className="text-headline text-ink-primary" data-testid="claimant-name">
                {registrant?.full_name ?? t("notRecorded")}
              </p>
            </div>
            <dl className="grid grid-cols-1 gap-design-2 sm:grid-cols-2">
              <Row compact={compact} label={t("householdRef")} testId="claimant-household-ref">
                <span className="font-mono">{h.household_ref}</span>
              </Row>
              <Row compact={compact} label={t("mobile")} testId="claimant-mobile">
                {h.contact_mobile ? (
                  <a href={`tel:${h.contact_mobile}`} className="font-medium text-forest underline">
                    {formatMobile(h.contact_mobile)}
                  </a>
                ) : notRecorded}
              </Row>
              <Row compact={compact} label={t("email")} testId="claimant-email">
                {h.contact_email ? (
                  <a href={`mailto:${h.contact_email}`} className="font-medium text-forest underline">
                    {h.contact_email}
                  </a>
                ) : notRecorded}
              </Row>
              <Row compact={compact} label={t("address")} testId="claimant-address">
                {h.address ? <span className="whitespace-pre-wrap">{h.address}</span> : notRecorded}
              </Row>
              <Row compact={compact} label={t("area")}>{`${h.district} / ${h.ds_division}`}</Row>
              <Row compact={compact} label={t("gnDivision")}>{h.gn_division ?? notRecorded}</Row>
              <Row compact={compact} label={t("registeredOn")}>{registered ?? notRecorded}</Row>
              {"bank_account_last4" in h && (
                <Row compact={compact} label={t("bankAccount")} testId="claimant-bank">
                  {h.bank_account_last4 ? t("bankAccountValue", { last4: h.bank_account_last4 }) : notRecorded}
                </Row>
              )}
            </dl>
            <div>
              <h3 className="text-label font-semibold text-ink-primary">
                {t("members", { count: h.members.length })}
              </h3>
              <ul className="mt-design-1 flex flex-col gap-design-1" data-testid="claimant-members">
                {registrant && (
                  <li className="text-body text-ink-primary">
                    {registrant.full_name ?? t("notRecorded")}
                    <span className="text-caption text-ink-secondary"> · {t("memberRegistrant")}</span>
                  </li>
                )}
                {others.map((m, i) => (
                  <li key={i} className="text-body text-ink-primary">
                    {m.full_name ?? t("notRecorded")}
                    {m.relationship && (
                      <span className="text-caption text-ink-secondary"> · {m.relationship}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-caption text-ink-secondary">{t("privacyNote")}</p>
          </>
        );
      })()}
    </section>
  );
}
