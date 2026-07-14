// Shared damage-category vocabulary (Story 6.3 code review fix) -- single source of truth for
// the canonical `report.step3` keys that have a translated label, mirroring statusVocabulary.ts's
// role for case statuses. Previously this Set was independently redefined in CaseListTable.tsx
// and CaseDetailPanel.tsx (byte-identical, but drift-prone), and FilterBar.tsx's damage-type
// dropdown had no equivalent guard at all. "none" is a valid case damage_category value (no
// visible damage) but is not offered as a FilterBar filter option.
export const DAMAGE_CATEGORY_KEYS = new Set(["crop", "property", "combined", "none"]);
