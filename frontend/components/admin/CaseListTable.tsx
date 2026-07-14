"use client";

// Admin case-list table (Story 5.3, AC3/AC4). No NIC or other citizen-identifying column —
// this list is deliberately PII-free, mirroring officer.py's "the payload is PII-free"
// convention; case detail (Story 5.4) is where an admin with a specific case open sees more.
import { useLocale, useTranslations } from "next-intl";
import type { AdminCaseListItem } from "@/lib/adminCases";
import { STATUS_STYLES } from "@/components/admin/statusVocabulary";

export type SortColumn = "submitted_at" | "canonical_id" | "damage_category" | "status";
export type SortDirection = "asc" | "desc";

interface CaseListTableProps {
  cases: AdminCaseListItem[];
  onSort: (col: SortColumn) => void;
  sortCol: SortColumn;
  sortDir: SortDirection;
  onSelect: (offlineId: string) => void;
  selectedOfflineId?: string | null;
}

// Story 6.3: labelKey resolves against the `admin.table.*` namespace; sortKey stays the canonical
// SortColumn value the backend/URL contract expects (do not translate sortKey).
const COLUMNS: { sortKey: SortColumn | null; labelKey: string }[] = [
  { sortKey: "canonical_id", labelKey: "colCanonicalId" },
  { sortKey: "damage_category", labelKey: "colDamageCategory" },
  { sortKey: null, labelKey: "colAiConfidence" },
  { sortKey: "status", labelKey: "colStatus" },
  { sortKey: "submitted_at", labelKey: "colSubmissionDate" },
  { sortKey: null, labelKey: "colDaysPending" },
];

// The 4 canonical damage-category values that have a shared report.step3 label; any other backend
// value (or null) falls back to the raw string (Story 6.3 AC4).
const DAMAGE_KEYS = new Set(["crop", "property", "combined", "none"]);

// Case status values are constrained to the 5 canonical STATUS_VALUES; the badge display reuses the
// shared status.statusLabels namespace keyed by the space-stripped value ("Under Review" ->
// "UnderReview"), the Story 6.2 officer-dashboard pattern.
function statusKey(status: string): string {
  return status.replace(/\s/g, "");
}

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
}: CaseListTableProps) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");
  const tReport = useTranslations("report");
  const locale = useLocale();

  const damageLabel = (cat: string | null): string =>
    cat ? (DAMAGE_KEYS.has(cat) ? tReport(`step3.${cat}`) : cat) : "—";

  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="border-b border-border-default text-left text-label font-medium text-ink-secondary">
          {COLUMNS.map(({ sortKey, labelKey }) => {
            const label = t(`table.${labelKey}`);
            return (
              <th key={labelKey} scope="col" className="px-design-3 py-design-2">
                {sortKey ? (
                  <button
                    type="button"
                    onClick={() => onSort(sortKey)}
                    className="flex items-center gap-design-1 font-medium"
                    aria-label={t("table.sortAria", { column: label })}
                  >
                    {label}
                    {sortCol === sortKey && (
                      <span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>
                    )}
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
              className={`cursor-pointer border-b border-border-default ${
                selected ? "bg-forest-pale" : "hover:bg-surface-tint"
              }`}
            >
              <td className="px-design-3 py-design-2 font-medium text-ink-primary">
                {c.canonical_id ?? "—"}
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {damageLabel(c.damage_category)}
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {c.ai_confidence != null ? `${Math.round(c.ai_confidence * 100)}%` : "—"}
              </td>
              <td className="px-design-3 py-design-2">
                <span
                  className={`rounded-full px-design-2 py-0.5 text-caption font-medium ${
                    STATUS_STYLES[c.status] ?? "bg-surface-tint text-ink-secondary"
                  }`}
                >
                  {tStatus(`statusLabels.${statusKey(c.status)}`)}
                </span>
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {formatDate(c.submitted_at, locale)}
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {daysPending(c.submitted_at, c.status)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
