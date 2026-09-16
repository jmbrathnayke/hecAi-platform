// A claim's status, translated and colour-coded.
//
// EXISTS BECAUSE THE SAME BUG APPEARED TWICE. Both the public status card and the citizen's case
// list rendered `case.status` — the raw English column value — so a Sinhala or Tamil reader saw
// "Payment Processed" and "Under Review" in English, in their own claim list, even though every
// label has been translated in all three message files since Story 2.5. The case list additionally
// painted every chip the same neutral grey, so an approved claim and a rejected one looked alike.
//
// Colour is never the only signal: the label itself carries the meaning, and the tone is an
// accompaniment (WCAG 1.4.1). Every pairing here is checked by __tests__/colourContrast.test.ts.
"use client";

import { useTranslations } from "next-intl";
import { isTranslatedStatus, statusKey } from "@/lib/status";

const TONE: Record<string, string> = {
  Submitted: "bg-civic-pale text-civic",
  "Under Review": "bg-amber-pale text-amber",
  Approved: "bg-forest-pale text-forest",
  "Payment Processed": "bg-forest-pale text-forest",
  Rejected: "bg-status-error-pale text-status-error",
};

export function StatusChip({ status }: { status: string }) {
  const t = useTranslations("status");
  // An unrecognised value is shown verbatim rather than hidden: a status the UI has not been
  // taught about is a deployment mismatch worth seeing, not something to paper over.
  const label = isTranslatedStatus(status) ? t(`statusLabels.${statusKey(status)}`) : status;
  const tone = TONE[status] ?? "bg-surface-base text-ink-secondary";

  return (
    <span
      className={`inline-block w-fit whitespace-nowrap rounded-pill px-design-3 py-design-1 text-caption font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}
