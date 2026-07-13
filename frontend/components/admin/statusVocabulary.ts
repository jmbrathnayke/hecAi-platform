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
