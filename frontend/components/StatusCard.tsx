// Public claim-status result (Story 2.5, FR-6.1).
//
// This is the whole answer to the only question the page exists to answer, so it leads with the
// outcome rather than with the metadata: the status as a heading, then what it means for the
// reader, then the journey, then the figures. The reference number moves to the top as a quiet
// caption — the citizen already has it, they typed it in.
//
// WHAT WAS WRONG BEFORE, beyond the visual flatness: the card decided whether it could translate a
// status by testing membership of KNOWN_STATUSES, which is the officer dashboard's FILTER list and
// ends at "Rejected". A claim that had been PAID therefore rendered the raw English string and a
// grey neutral chip — in Sinhala and Tamil too, for the one outcome the whole workflow exists to
// reach. The translations were in every message file already. See lib/status.ts.
"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  type CaseStatus,
  isTranslatedStatus,
  journeyIndex,
  statusKey,
  showApprovedAmount,
} from "@/lib/status";
import { ClaimProgress } from "@/components/ClaimProgress";

/** Accent per status: a dot colour and the tone of the headline. Never the only signal. */
const ACCENT: Record<string, { dot: string; text: string }> = {
  Submitted: { dot: "bg-status-pending", text: "text-ink-primary" },
  "Under Review": { dot: "bg-status-warning", text: "text-ink-primary" },
  Approved: { dot: "bg-forest", text: "text-forest" },
  "Payment Processed": { dot: "bg-status-processed", text: "text-forest" },
  Rejected: { dot: "bg-status-error", text: "text-status-error" },
};

export function StatusCard({
  canonical_id,
  offline_id,
  status,
  updated_at,
  approved_amount,
}: CaseStatus) {
  const t = useTranslations("status");
  const locale = useLocale();
  const [copied, setCopied] = useState(false);

  const displayRef = canonical_id ?? offline_id;
  const known = isTranslatedStatus(status);
  const label = known ? t(`statusLabels.${statusKey(status)}`) : status;
  const accent = ACCENT[status] ?? { dot: "bg-ink-disabled", text: "text-ink-primary" };
  const onJourney = journeyIndex(status) >= 0;

  const updated = updated_at ? new Date(updated_at) : null;
  const updatedText =
    updated && !isNaN(updated.getTime())
      ? updated.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" })
      : "—";

  async function copyRef() {
    try {
      await navigator.clipboard.writeText(displayRef);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable over plain HTTP on some browsers and blocked in others. The
      // reference is selectable text either way, so there is nothing to report.
    }
  }

  return (
    <section
      aria-live="polite"
      className="overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-raised"
    >
      <div className="flex items-center justify-between gap-design-3 border-b border-border-subtle px-design-5 py-design-3">
        <span className="select-all break-all font-mono text-label text-ink-secondary">
          {displayRef}
        </span>
        <button
          type="button"
          onClick={() => void copyRef()}
          className="shrink-0 rounded-sm px-design-2 py-design-1 text-caption font-semibold text-forest transition-colors duration-quick hover:bg-forest-pale"
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>

      <div className="flex flex-col gap-design-5 p-design-5">
        <div>
          <div className="flex items-center gap-design-2">
            <span aria-hidden="true" className={`h-3 w-3 rounded-full ${accent.dot}`} />
            <h2 className={`text-title ${accent.text}`}>{label}</h2>
          </div>
          {known && (
            <p className="mt-design-2 text-body text-ink-secondary">
              {t(`nextStep.${statusKey(status)}`)}
            </p>
          )}
        </div>

        {onJourney && <ClaimProgress status={status} />}

        <dl className="grid grid-cols-1 gap-design-3 sm:grid-cols-2">
          {showApprovedAmount({ status, approved_amount }) && (
            // The figure the family is actually waiting for. Given its own tile and set at display
            // size: in the previous card it sat in body text, the same weight as the date beside it.
            <div className="rounded-sm bg-forest-pale px-design-4 py-design-3">
              <dt className="text-caption text-ink-secondary">{t("approvedAmount")}</dt>
              <dd className="mt-design-1 text-display text-forest">
                LKR {approved_amount!.toLocaleString(locale)}
              </dd>
            </div>
          )}
          <div className="rounded-sm bg-surface-base px-design-4 py-design-3">
            <dt className="text-caption text-ink-secondary">{t("lastUpdated")}</dt>
            <dd className="mt-design-1 text-headline text-ink-primary">{updatedText}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
