"use client";

// Admin case-list filter bar (Story 5.3, AC2). Deliberately has NO district control — the
// admin's district is their fixed RBAC scope (g.district_id, server-enforced), not a
// user-selectable filter, correcting the older UX mockup's stale "All Districts" dropdown
// that predates the RBAC design. Filter state lives in the URL (bookmarkable).
export interface AdminCaseFilters {
  status: string;
  from: string;
  to: string;
  type: string;
  division: string;
}

export const EMPTY_FILTERS: AdminCaseFilters = {
  status: "",
  from: "",
  to: "",
  type: "",
  division: "",
};

const STATUS_OPTIONS = ["Submitted", "Under Review", "Approved", "Rejected", "Payment Processed"];
const DAMAGE_TYPE_OPTIONS = ["crop", "property", "combined"];

interface FilterBarProps {
  value: AdminCaseFilters;
  onApply: (filters: AdminCaseFilters) => void;
  onClear: () => void;
}

export function FilterBar({ value, onApply, onClear }: FilterBarProps) {
  // Uncontrolled-by-parent-until-Apply: local draft state so typing doesn't refetch on
  // every keystroke; "Apply Filters" commits the draft to the URL/parent.
  const formId = "admin-case-filter-form";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    onApply({
      status: String(form.get("status") ?? ""),
      from: String(form.get("from") ?? ""),
      to: String(form.get("to") ?? ""),
      type: String(form.get("type") ?? ""),
      division: String(form.get("division") ?? ""),
    });
  }

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-design-3"
      aria-label="Filter cases"
    >
      <div className="flex flex-col gap-design-1">
        <label htmlFor="filter-status" className="text-label font-medium text-ink-secondary">
          Status
        </label>
        <select
          id="filter-status"
          name="status"
          defaultValue={value.status}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="filter-from" className="text-label font-medium text-ink-secondary">
          From
        </label>
        <input
          id="filter-from"
          name="from"
          type="date"
          defaultValue={value.from}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        />
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="filter-to" className="text-label font-medium text-ink-secondary">
          To
        </label>
        <input
          id="filter-to"
          name="to"
          type="date"
          defaultValue={value.to}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        />
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="filter-type" className="text-label font-medium text-ink-secondary">
          Damage Type
        </label>
        <select
          id="filter-type"
          name="type"
          defaultValue={value.type}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        >
          <option value="">All Types</option>
          {DAMAGE_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-design-1">
        <label htmlFor="filter-division" className="text-label font-medium text-ink-secondary">
          DS Division
        </label>
        <input
          id="filter-division"
          name="division"
          type="text"
          defaultValue={value.division}
          placeholder="Search division…"
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        />
      </div>

      <div className="flex gap-design-2">
        <button
          type="submit"
          className="min-h-touch-target rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark"
        >
          Apply Filters
        </button>
        <button
          type="button"
          onClick={onClear}
          className="min-h-touch-target rounded-md px-design-3 text-label font-medium text-ink-secondary underline"
        >
          Clear Filters
        </button>
      </div>
    </form>
  );
}
