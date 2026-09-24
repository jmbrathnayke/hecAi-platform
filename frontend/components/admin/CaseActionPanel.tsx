"use client";

// Case review action panel (Story 5.5, AC1-3). Status-dependent button set -- four actions
// (Approve/Reject/Request More Info/Escalate) pre-approval, one (Mark as Paid) once Approved,
// nothing once closed (Rejected/Payment Processed) -- matching the real UX mockup and FR-6.2's
// closed status-label state machine (there is no "Escalated" status; see lib/adminCaseDetail's
// AdminCaseAction doc comment).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import {
  performCaseAction,
  UNAUTHORIZED,
  type AdminCaseAction,
  type AdminCaseDetailResponse,
} from "@/lib/adminCaseDetail";
import { CLOSED_STATUSES } from "@/components/admin/statusVocabulary";

// Mirrors backend/app/api/v1/admin.py's MIN_REASON_LENGTH -- client-side check is a UX
// nicety (avoid a round trip just to learn a reason is too short); the server enforces this
// regardless.
const MIN_REASON_LENGTH = 10;

// Maps each action to its `admin.action.*` label key (Story 6.3). The action ENUM values
// (approve/reject/…) are the API contract and are unchanged; only the display label is translated.
const ACTION_LABEL_KEYS: Record<AdminCaseAction, string> = {
  approve: "labelApprove",
  reject: "labelReject",
  request_info: "labelRequestInfo",
  escalate: "labelEscalate",
  mark_paid: "labelMarkPaid",
};

interface CaseActionPanelProps {
  offlineId: string;
  status: string;
  hasEstimate: boolean;
  estimateAmountLkr: number | null;
  onActionComplete: (updated: AdminCaseDetailResponse) => void;
  /**
   * Final governance workflow. false = a citizen report no field officer has verified yet; the
   * backend refuses to approve it (409 officer_assessment_required). undefined = unknown (older
   * backend) and treated as before.
   */
  officerAssessed?: boolean;
  /** false = approved and forwarded, awaiting the Divisional Secretariat's final decision. */
  dsFinalDecided?: boolean;
}

function isClosed(status: string): boolean {
  return CLOSED_STATUSES.has(status);
}

export function CaseActionPanel({
  offlineId,
  status,
  hasEstimate,
  estimateAmountLkr,
  onActionComplete,
  officerAssessed,
  dsFinalDecided,
}: CaseActionPanelProps) {
  const approvalBlocked = officerAssessed === false;
  const router = useRouter();
  const t = useTranslations("admin");
  const [activeAction, setActiveAction] = useState<AdminCaseAction | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog(action: AdminCaseAction) {
    setActiveAction(action);
    setAmount(estimateAmountLkr != null ? String(estimateAmountLkr) : "");
    setReason("");
    setError(null);
  }

  function closeDialog() {
    setActiveAction(null);
    setError(null);
  }

  const amountChanged =
    activeAction === "approve" && estimateAmountLkr != null && Number(amount) !== estimateAmountLkr;
  const reasonRequired =
    activeAction === "reject" || (activeAction === "approve" && (amountChanged || !hasEstimate));
  const showReasonField =
    activeAction === "reject" || activeAction === "request_info" || activeAction === "escalate" ||
    (activeAction === "approve" && reasonRequired);
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  // >= 0, not > 0 (code review fix): a genuine RF estimate of exactly 0 LKR (no assessed
  // damage) is a real value the backend accepts -- rejecting it here made a legitimate
  // zero-compensation case impossible to ever approve through this dialog.
  const amountValid = activeAction !== "approve" || (amount !== "" && Number(amount) >= 0);
  const canSubmit = amountValid && (!reasonRequired || reasonValid);

  async function handleConfirm() {
    if (!activeAction || submitting || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    const token = await getAccessToken();
    if (!token) {
      // setSubmitting(false) (code review fix): without this, a redirect that doesn't
      // synchronously unmount the component (a soft navigation, a slow route transition)
      // left the Confirm button permanently stuck disabled on "Submitting…".
      setSubmitting(false);
      router.replace("/admin/login");
      return;
    }

    const options: { amountLkr?: number; reason?: string } = {};
    if (activeAction === "approve") options.amountLkr = Number(amount);
    if (reason.trim()) options.reason = reason.trim();

    const result = await performCaseAction(token, offlineId, activeAction, options);
    setSubmitting(false);
    if (result === UNAUTHORIZED) {
      router.replace("/admin/login");
      return;
    }
    if (!result) {
      setError(
        activeAction === "approve" && approvalBlocked
          ? t("action.assessmentRequired")
          : t("action.actionError"),
      );
      return;
    }
    onActionComplete(result);
    closeDialog();
  }

  if (isClosed(status)) {
    return (
      <div className="rounded-md border border-dashed border-border-default p-design-4 text-body text-ink-disabled">
        {t("action.closed")}
      </div>
    );
  }

  return (
    <div className="space-y-design-3">
      {/* was `text-heading-3` — undefined token; see AIResultPanel. DESIGN.md § Typography. */}
      <h3 className="text-headline text-ink-primary">{t("action.heading")}</h3>

      {status === "Approved" && dsFinalDecided === false ? (
        // Approved means forwarded. The Divisional Secretariat decides the final amount and
        // authorises payment from its own portal; there is nothing for the administrator to pay.
        <p className="rounded-md bg-surface-tint p-design-3 text-body text-ink-secondary" data-testid="awaiting-ds-decision">
          {t("action.awaitingDsDecision")}
        </p>
      ) : status === "Approved" ? (
        <button
          type="button"
          onClick={() => openDialog("mark_paid")}
          className="min-h-touch-target rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark"
        >
          {t("action.markPaid")}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-design-2">
          {approvalBlocked && (
            <p role="note" className="col-span-2 rounded-md bg-status-warning/25 p-design-3 text-body text-ink-primary" data-testid="assessment-required">
              {t("action.assessmentRequired")}
            </p>
          )}
          <button
            type="button"
            onClick={() => openDialog("approve")}
            disabled={approvalBlocked}
            className="min-h-touch-target rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-50"
          >
            {t("action.approve")}
          </button>
          <button
            type="button"
            onClick={() => openDialog("reject")}
            className="min-h-touch-target rounded-md bg-status-error px-design-4 text-label font-semibold text-white"
          >
            {t("action.reject")}
          </button>
          <button
            type="button"
            onClick={() => openDialog("request_info")}
            className="min-h-touch-target rounded-md border border-amber px-design-4 text-label font-semibold text-amber"
          >
            {t("action.requestInfo")}
          </button>
          <button
            type="button"
            onClick={() => openDialog("escalate")}
            className="min-h-touch-target rounded-md border border-amber px-design-4 text-label font-semibold text-amber"
          >
            {t("action.escalate")}
          </button>
        </div>
      )}

      {activeAction && (
        <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4 space-y-design-3">
          <h4 className="text-label font-semibold text-ink-primary">
            {t("action.confirmTitle", { action: t(`action.${ACTION_LABEL_KEYS[activeAction]}`) })}
          </h4>

          {activeAction === "approve" && (
            <div className="space-y-design-1">
              <label htmlFor="approve-amount" className="text-label text-ink-secondary">
                {t("action.approvedAmount")}
              </label>
              <input
                id="approve-amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-md border border-border-default px-design-3 py-design-2 text-body"
              />
              <p className="text-caption text-ink-secondary">{t("action.forwardNote")}</p>
            </div>
          )}

          {showReasonField && (
            <div className="space-y-design-1">
              <label htmlFor="action-reason" className="text-label text-ink-secondary">
                {reasonRequired ? t("action.reason") : t("action.reasonOptional")}
              </label>
              <textarea
                id="action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-border-default px-design-3 py-design-2 text-body"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-label text-status-error">
              {error}
            </p>
          )}

          <div className="flex gap-design-3">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canSubmit || submitting}
              className="min-h-touch-target flex-1 rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-50"
            >
              {submitting ? t("action.submitting") : t("action.confirm")}
            </button>
            <button
              type="button"
              onClick={closeDialog}
              disabled={submitting}
              className="min-h-touch-target flex-1 rounded-md border border-border-default px-design-4 text-label text-ink-secondary disabled:opacity-50"
            >
              {t("action.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
