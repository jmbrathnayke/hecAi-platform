"use client";
// Divisional Secretariat final compensation review (final governance workflow).
//
// The one screen on the platform where a compensation amount is DECIDED. Everything before it is
// input to a human: the Random Forest's AI-assisted estimate (decision support) and the DWC
// administrator's recommended amount. Both are shown, labelled for what they are, and the officer
// confirms one or enters a different figure with a reason. The backend records the decision in the
// hash-chained audit trail against this officer's account and notifies the family and the district
// administrator (app/api/v1/ds.py::record_final_decision).
import { useState } from "react";
import { recordFinalDecision, type DsCase, type FinalDecision, type FinalDecisionFailure } from "@/lib/dsCases";
import { buttonStyles, fieldStyles } from "@/components/admin/ui";

const MIN_REASON_LENGTH = 10;

interface Props {
  dsCase: DsCase;
  t: (key: string, values?: Record<string, string | number>) => string;
  onDecided: (decision: FinalDecision) => void;
  onCancel: () => void;
}

function failureKey(f: FinalDecisionFailure): string {
  switch (f.reason) {
    case "reason-required":
      return "finalDecision.error.reasonRequired";
    case "invalid-amount":
      return "finalDecision.error.invalidAmount";
    case "not-approved":
      return "finalDecision.error.notApproved";
    case "payment-authorized":
      return "finalDecision.error.paymentAuthorized";
    case "no-payment-record":
      return "finalDecision.error.noPaymentRecord";
    case "not-found":
    case "forbidden":
      return "finalDecision.error.notFound";
    case "network":
      return "finalDecision.error.network";
    default:
      return "finalDecision.error.server";
  }
}

function lkr(amount: number | null | undefined): string {
  return typeof amount === "number" ? `LKR ${amount.toLocaleString()}` : "—";
}

export function DsFinalDecisionPanel({ dsCase, t, onDecided, onCancel }: Props) {
  const aiEstimate = dsCase.ai_estimate?.amount_lkr ?? null;
  // Pre-filled with the most recent human figure, so confirming a recommendation is one click --
  // but never silently: the officer still presses "Record final decision".
  const initial = dsCase.final_decision?.amount_lkr ?? dsCase.approved_amount ?? aiEstimate;
  const [amount, setAmount] = useState(initial === null || initial === undefined ? "" : String(initial));
  const [reason, setReason] = useState(dsCase.final_decision?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FinalDecisionFailure | null>(null);

  const parsed = amount.trim() === "" ? NaN : Number(amount);
  const amountValid = Number.isFinite(parsed) && parsed >= 0;
  const differsFromAi = aiEstimate === null || (amountValid && parsed !== aiEstimate);
  const reasonOk = !differsFromAi || reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit = amountValid && reasonOk && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(null);
    const result = await recordFinalDecision(dsCase.canonical_id, parsed, reason.trim() || null);
    setBusy(false);
    if (result.ok) onDecided(result.decision);
    else setFailure(result.failure);
  }

  return (
    <section className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card sm:p-design-5" data-testid="final-decision-panel">
      <h2 className="text-label font-semibold text-ink-primary">
        {t("finalDecision.title")}{" "}
        <span className="ml-design-1 font-staff-mono text-caption font-medium text-ink-secondary">{dsCase.canonical_id}</span>
      </h2>

      <dl className="grid grid-cols-1 gap-design-2 sm:grid-cols-2">
        <div className="rounded-sm border border-status-warning/40 bg-surface-base px-design-3 py-design-2" data-testid="ds-ai-estimate">
          <dt className="text-caption text-ink-secondary">{t("finalDecision.aiEstimate")}</dt>
          <dd className="text-headline tabular-nums text-ink-primary">{lkr(aiEstimate)}</dd>
          <dd className="text-caption font-semibold text-status-warning">{t("finalDecision.aiEstimateNote")}</dd>
          {dsCase.ai_estimate?.synthetic_model && (
            <dd className="text-caption font-semibold text-status-warning" data-testid="ds-estimate-synthetic">
              {t("finalDecision.aiEstimateSynthetic")}
            </dd>
          )}
        </div>
        <div className="rounded-sm bg-surface-base px-design-3 py-design-2">
          <dt className="text-caption text-ink-secondary">{t("finalDecision.dwcAmount")}</dt>
          <dd className="text-headline tabular-nums text-ink-primary">{lkr(dsCase.approved_amount)}</dd>
          <dd className="text-caption text-ink-secondary">
            {dsCase.officer_assessed ? t("finalDecision.officerAssessed") : t("finalDecision.officerNotAssessed")}
          </dd>
        </div>
      </dl>

      <label className="flex flex-col gap-design-1 text-caption font-medium text-ink-secondary">
        {t("finalDecision.amountLabel")}
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={!amountValid}
          className={`${fieldStyles} min-h-[44px] text-body tabular-nums`}
        />
      </label>

      <label className="flex flex-col gap-design-1 text-caption font-medium text-ink-secondary">
        {t("finalDecision.reasonLabel")}
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          aria-invalid={!reasonOk}
          className={`${fieldStyles} py-design-2 text-body`}
        />
        <span className="text-caption text-ink-secondary">{t("finalDecision.reasonHint")}</span>
      </label>

      <p className="text-caption text-ink-secondary">{t("finalDecision.humanDecision")}</p>

      {failure && (
        <p role="alert" className="text-caption text-status-error">
          {t(failureKey(failure))}
        </p>
      )}

      <div className="flex flex-wrap gap-design-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className={buttonStyles.primary}
        >
          {busy ? t("finalDecision.saving") : t("finalDecision.confirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={buttonStyles.secondary}
        >
          {t("finalDecision.cancel")}
        </button>
      </div>
    </section>
  );
}
