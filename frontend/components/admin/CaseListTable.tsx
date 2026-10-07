"use client";

// Admin case-list table (Story 5.3, AC3/AC4). No NIC or other citizen-identifying column —
// this list is deliberately PII-free, mirroring officer.py's "the payload is PII-free"
// convention; case detail (Story 5.4) is where an admin with a specific case open sees more.
import { useLocale, useTranslations } from "next-intl";
import type { AdminCaseListItem } from "@/lib/adminCases";
import { statusKey } from "@/lib/status";
import { STATUS_VALUES } from "@/components/admin/statusVocabulary";
import { CaretDown, CaretUp, CaretUpDown, Warning } from "@phosphor-icons/react";
import { StatusBadge } from "@/components/admin/ui";
import { DAMAGE_CATEGORY_KEYS } from "@/components/admin/damageVocabulary";

export type SortColumn = "submitted_at" | "canonical_id" | "damage_category" | "status";
export type SortDirection = "asc" | "desc";

interface CaseListTableProps {
  cases: AdminCaseListItem[];
  onSort: (col: SortColumn) => void;
  sortCol: SortColumn;
  sortDir: SortDirection;
  onSelect: (offlineId: string) => void;
  selectedOfflineId?: string | null;
  /** True while a case is open in the rail beside the list. The two secondary columns then step
   *  aside below 2xl so the reference, verification, status and date stay in view. */
  condensed?: boolean;
}

// Story 6.3: labelKey resolves against the `admin.table.*` namespace; sortKey stays the canonical
// SortColumn value the backend/URL contract expects (do not translate sortKey).
const COLUMNS: { sortKey: SortColumn | null; labelKey: string; secondary?: boolean }[] = [
  { sortKey: "canonical_id", labelKey: "colCanonicalId" },
  { sortKey: "damage_category", labelKey: "colDamageCategory" },
  { sortKey: null, labelKey: "colAiConfidence", secondary: true },
  // Placed immediately before Status, which is the column the approver acts on. An approver
  // scanning this list is deciding whether to authorise money; whether anyone actually saw the
  // damage belongs next to that decision, not at the far end of a horizontally scrolling table.
  { sortKey: null, labelKey: "colVerification" },
  { sortKey: "status", labelKey: "colStatus" },
  { sortKey: "submitted_at", labelKey: "colSubmissionDate" },
  { sortKey: null, labelKey: "colDaysPending", secondary: true },
];

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(locale);
}

function daysPending(iso: string | null, status: string): string {
  // Only meaningful while a case is still "Submitted" (code review fix) -- matches the
  // backend's avg_processing_days KPI, which freezes at updated_at - submitted_at once a
  // case leaves 'Submitted' instead of counting time after resolution.
  if (status !== "Submitted") return "—";
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days < 0 ? "0" : String(days);
}

export function CaseListTable({
  cases,
  onSort,
  sortCol,
  sortDir,
  onSelect,
  selectedOfflineId,
  condensed = false,
}: CaseListTableProps) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");
  const tReport = useTranslations("report");
  const locale = useLocale();

  const damageLabel = (cat: string | null): string =>
    cat ? (DAMAGE_CATEGORY_KEYS.has(cat) ? tReport(`step3.${cat}`) : cat) : "—";

  // Case status values are constrained to the 5 canonical STATUS_VALUES in normal operation, but
  // the `status` column has no DB-level CHECK constraint -- fall back to the raw value for
  // anything outside that set instead of rendering next-intl's missing-message placeholder
  // (Story 6.3 code review fix, mirrors StatusCard.tsx's isKnown guard).
  // Hidden, not removed: the cells stay in the DOM (and in each row's cell order).
  const secondary = condensed ? "hidden 2xl:table-cell" : "";

  const statusLabel = (status: string): string =>
    (STATUS_VALUES as readonly string[]).includes(status)
      ? tStatus(`statusLabels.${statusKey(status)}`)
      : status;

  return (
    // min-w-[720px] is what makes the parent's `overflow-x-auto` actually engage on mobile: with
    // `w-full` alone the table can never exceed its container, and seven columns squeezed into a
    // phone wrap every cell. The table keeps legible column widths and scrolls sideways instead.
    //
    // Redesign (2026-10-07): 14px rows, a sentence-case header that stays put while the list
    // scrolls, square-cornered status badges that never wrap, and the case reference in Geist
    // Mono so references line up digit for digit.
    <table className={`w-full border-collapse text-label ${condensed ? "min-w-[560px] 2xl:min-w-[720px]" : "min-w-[720px]"}`}>
      <thead className="sticky top-0 z-10">
        <tr className="border-b border-border-subtle bg-surface-base text-left text-caption font-medium text-ink-secondary">
          {COLUMNS.map(({ sortKey, labelKey, secondary: isSecondary }) => {
            const label = t(`table.${labelKey}`);
            const active = sortCol === sortKey;
            const SortIcon = !active ? CaretUpDown : sortDir === "asc" ? CaretUp : CaretDown;
            return (
              <th
                key={labelKey}
                scope="col"
                aria-sort={sortKey && active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                className={`whitespace-nowrap px-design-3 py-design-3 font-medium ${isSecondary ? secondary : ""}`}
              >
                {sortKey ? (
                  <button
                    type="button"
                    onClick={() => onSort(sortKey)}
                    className={`inline-flex items-center gap-design-1 rounded-sm transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest ${
                      active ? "text-ink-primary" : ""
                    }`}
                    aria-label={t("table.sortAria", { column: label })}
                  >
                    {label}
                    <SortIcon aria-hidden="true" size={12} className={active ? "text-forest" : "opacity-50"} />
                  </button>
                ) : (
                  label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {cases.map((c, i) => {
          // Array index fallback (code review fix): offline_id is UUID NOT NULL by schema
          // (migration 002), so this branch should never run in practice -- but a key that
          // changes every render (the old Math.random() fallback) defeats React
          // reconciliation and forces a full remount on every re-render, making the
          // "should never happen" case worse than a no-op.
          const key = c.offline_id ?? c.canonical_id ?? `row-${i}`;
          const selected = !!c.offline_id && c.offline_id === selectedOfflineId;
          const select = () => c.offline_id && onSelect(c.offline_id);
          return (
            <tr
              key={key}
              onClick={select}
              tabIndex={0}
              role="button"
              aria-pressed={selected}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select();
                }
              }}
              // border-l-[3px] on both branches (transparent when unselected) so selecting a
              // row does not shift its cells sideways by 3px.
              className={`cursor-pointer border-b border-l-[3px] border-b-border-subtle transition-colors duration-150 last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-forest motion-reduce:transition-none ${
                selected ? "border-l-forest bg-surface-tint" : "border-l-transparent hover:bg-surface-base"
              }`}
            >
              {/* whitespace-nowrap: "HEC-2026-0041" was breaking at every hyphen into a
                  three-line stack whenever the column got tight. The reference is the row's
                  identity — it must stay on one line and let the table scroll instead. */}
              <td className="whitespace-nowrap px-design-3 py-design-3 font-staff-mono font-medium text-ink-primary">
                {c.canonical_id ?? "—"}
              </td>
              <td className="whitespace-nowrap px-design-3 py-design-3 text-ink-secondary">
                {damageLabel(c.damage_category)}
              </td>
              <td className={`px-design-3 py-design-3 tabular-nums text-ink-secondary ${secondary}`}>
                {c.ai_confidence != null ? `${Math.round(c.ai_confidence * 100)}%` : "—"}
              </td>
              {/* Unverified is styled as a warning, verified as ordinary text. The asymmetry is
                  deliberate: an officer-verified claim is the expected case and needs no emphasis,
                  while an unverified one is the exception the approver must notice before
                  authorising payment. Colour alone never carries it — the label and the icon
                  state which. The badge is a warning TINT behind dark ink, so the tint carries
                  the signal and ink-primary carries the contrast. */}
              <td className="whitespace-nowrap px-design-3 py-design-3">
                {/* Verified = officer-assisted at submission, or a field officer has since recorded
                    an assessment of the citizen's report (final governance workflow). */}
                {(c.officer_assessed ?? c.submitted_by_officer) ? (
                  <span className="text-caption text-ink-secondary">
                    {t("table.verifiedByOfficer")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-status-warning/15 px-design-2 py-0.5 text-caption font-medium text-ink-primary">
                    <Warning aria-hidden="true" size={12} weight="fill" className="text-status-warning" />
                    {t("table.notVerified")}
                  </span>
                )}
              </td>
              <td className="px-design-3 py-design-3">
                <StatusBadge status={c.status} label={statusLabel(c.status)} />
              </td>
              <td className="whitespace-nowrap px-design-3 py-design-3 tabular-nums text-ink-secondary">
                {formatDate(c.submitted_at, locale)}
              </td>
              <td className={`px-design-3 py-design-3 tabular-nums text-ink-secondary ${secondary}`}>
                {daysPending(c.submitted_at, c.status)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
