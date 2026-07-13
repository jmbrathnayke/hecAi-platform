"use client";

// Admin case-list table (Story 5.3, AC3/AC4). No NIC or other citizen-identifying column —
// this list is deliberately PII-free, mirroring officer.py's "the payload is PII-free"
// convention; case detail (Story 5.4) is where an admin with a specific case open sees more.
import type { AdminCaseListItem } from "@/lib/adminCases";

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

// Only "Submitted" is reachable in real data today (Story 5.5 builds the other
// transitions) — all 5 are styled anyway so Story 5.5 doesn't need to touch this file.
const STATUS_STYLES: Record<string, string> = {
  Submitted: "bg-civic-pale text-civic",
  "Under Review": "bg-amber-pale text-amber",
  Approved: "bg-forest-pale text-forest",
  Rejected: "bg-status-error/10 text-status-error",
  "Payment Processed": "bg-surface-tint text-ink-secondary",
};

const COLUMNS: { key: SortColumn | null; label: string }[] = [
  { key: "canonical_id", label: "Canonical ID" },
  { key: "damage_category", label: "Damage Category" },
  { key: null, label: "AI Confidence" },
  { key: "status", label: "Status" },
  { key: "submitted_at", label: "Submission Date" },
  { key: null, label: "Days Pending" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function daysPending(iso: string | null): string {
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
  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="border-b border-border-default text-left text-label font-medium text-ink-secondary">
          {COLUMNS.map(({ key, label }) => (
            <th key={label} scope="col" className="px-design-3 py-design-2">
              {key ? (
                <button
                  type="button"
                  onClick={() => onSort(key)}
                  className="flex items-center gap-design-1 font-medium"
                  aria-label={`Sort by ${label}`}
                >
                  {label}
                  {sortCol === key && <span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </button>
              ) : (
                label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => {
          const key = c.offline_id ?? c.canonical_id ?? Math.random().toString(36);
          const selected = !!c.offline_id && c.offline_id === selectedOfflineId;
          return (
            <tr
              key={key}
              onClick={() => c.offline_id && onSelect(c.offline_id)}
              className={`cursor-pointer border-b border-border-default ${
                selected ? "bg-forest-pale" : "hover:bg-surface-tint"
              }`}
            >
              <td className="px-design-3 py-design-2 font-medium text-ink-primary">
                {c.canonical_id ?? "—"}
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {c.damage_category ?? "—"}
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
                  {c.status}
                </span>
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {formatDate(c.submitted_at)}
              </td>
              <td className="px-design-3 py-design-2 text-ink-secondary">
                {daysPending(c.submitted_at)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
