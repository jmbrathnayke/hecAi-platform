// Public claim-status result card (Story 2.5). Shows reference, a colour-coded status
// badge, last-updated date, and the approved amount only for Approved claims.
"use client";

import { useTranslations, useLocale } from "next-intl";
import {
  type CaseStatus,
  KNOWN_STATUSES,
  statusKey,
  showApprovedAmount,
} from "@/lib/status";

const BADGE: Record<string, string> = {
  Submitted: "bg-status-pending text-ink-on-dark",
  "Under Review": "bg-status-warning text-ink-primary",
  Approved: "bg-forest text-ink-on-dark",
  Rejected: "bg-status-error text-ink-on-dark",
};

export function StatusCard({ canonical_id, offline_id, status, updated_at, approved_amount }: CaseStatus) {
  const t = useTranslations("status");
  const locale = useLocale();
  const displayRef = canonical_id ?? offline_id;
  const isKnown = (KNOWN_STATUSES as readonly string[]).includes(status);
  const label = isKnown ? t(`statusLabels.${statusKey(status)}`) : status;
  const badge = BADGE[status] ?? "bg-surface-tint text-ink-secondary";
  // Guard null/empty (epoch-0 would otherwise render as 1970) and format in the active locale.
  const updated = updated_at ? new Date(updated_at) : null;
  const updatedText =
    updated && !isNaN(updated.getTime()) ? updated.toLocaleDateString(locale) : "—";

  return (
    <div className="flex flex-col gap-design-3 rounded-md border border-border-default bg-surface-raised p-design-5">
      <span className="select-all break-all text-label text-ink-disabled">{displayRef}</span>

      <span
        className={`inline-block w-fit rounded-full px-design-3 py-design-1 text-label font-semibold ${badge}`}
      >
        {label}
      </span>

      <p className="text-body text-ink-secondary">
        {t("lastUpdated")}: {updatedText}
      </p>

      {showApprovedAmount({ status, approved_amount }) && (
        <p className="text-body font-semibold text-ink-primary">
          {t("approvedAmount")}: LKR {approved_amount!.toLocaleString(locale)}
        </p>
      )}
    </div>
  );
}
