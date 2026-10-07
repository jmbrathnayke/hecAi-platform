// Shared case-status vocabulary (Story 5.3 code review fix) -- single source of truth for
// both CaseListTable's badge styling and FilterBar's status dropdown, which previously
// hand-duplicated this list. Only "Submitted" is reachable in real data today (Story 5.5
// builds the other transitions); all 5 are listed anyway so Story 5.5 doesn't need to touch
// either consuming file.
export const STATUS_VALUES = [
  "Submitted",
  "Under Review",
  "Approved",
  "Rejected",
  "Payment Processed",
] as const;

export const STATUS_STYLES: Record<string, string> = {
  Submitted: "bg-civic-pale text-civic",
  "Under Review": "bg-amber-pale text-amber",
  Approved: "bg-forest-pale text-forest",
  Rejected: "bg-status-error/10 text-status-error",
  "Payment Processed": "bg-surface-tint text-ink-secondary",
};

// Solid fills for the status-mix bar on the case list (admin redesign, 2026-10-07). Same hue per
// status as the badges above, so a colour in the bar means the same thing as a colour in the table.
export const STATUS_FILLS: Record<string, string> = {
  Submitted: "bg-civic",
  "Under Review": "bg-amber",
  Approved: "bg-forest",
  Rejected: "bg-status-error",
  "Payment Processed": "bg-border-default",
};

// Terminal statuses -- no further case-review action is possible once a case reaches one of
// these (code review fix, Story 5.5: CaseActionPanel previously hand-duplicated this pair
// instead of reusing this file, the same anti-pattern this file was created to avoid).
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(["Rejected", "Payment Processed"]);
