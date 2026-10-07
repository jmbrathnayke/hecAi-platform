"use client";

// Admin case-list filter bar (Story 5.3, AC2). Deliberately has NO district control — the
// admin's district is their fixed RBAC scope (g.district_id, server-enforced), not a
// user-selectable filter, correcting the older UX mockup's stale "All Districts" dropdown
// that predates the RBAC design. Filter state lives in the URL (bookmarkable).
import { useTranslations } from "next-intl";
import { CaretDown, Funnel } from "@phosphor-icons/react";
import { statusKey } from "@/lib/status";
import { STATUS_VALUES } from "@/components/admin/statusVocabulary";
import { DAMAGE_CATEGORY_KEYS } from "@/components/admin/damageVocabulary";
import { buttonStyles, fieldStyles } from "@/components/admin/ui";

export interface AdminCaseFilters {
  status: string;
  from: string;
  to: string;
  type: string;
  division: string;
  /** "" | "assessed" | "pending" (final governance workflow). */
  assessment: string;
  /** Responsible officer account id, exact. */
  officer: string;
}

export const EMPTY_FILTERS: AdminCaseFilters = {
  status: "",
  from: "",
  to: "",
  type: "",
  division: "",
  assessment: "",
  officer: "",
};

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
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");
  const tReport = useTranslations("report");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    onApply({
      status: String(form.get("status") ?? ""),
      from: String(form.get("from") ?? ""),
      to: String(form.get("to") ?? ""),
      type: String(form.get("type") ?? ""),
      division: String(form.get("division") ?? ""),
      assessment: String(form.get("assessment") ?? ""),
      officer: String(form.get("officer") ?? ""),
    });
  }

  // The two workflow filters sit behind "More filters". The disclosure starts open when either is
  // set, so an applied filter is never hidden. Closed or open, its fields stay in the form.
  const advancedCount = (value.assessment ? 1 : 0) + (value.officer ? 1 : 0);

  return (
    <form
      // Keying on a serialization of `value` forces a remount whenever the filters change
      // externally (Clear Filters, browser back/forward) -- code review fix: these inputs
      // are uncontrolled `defaultValue`, which React never re-applies on props changing
      // without a remount, so the visible and actually-applied filter state could diverge.
      key={JSON.stringify(value)}
      id={formId}
      onSubmit={handleSubmit}
      className="w-full rounded-md border border-border-subtle bg-surface-raised p-design-3 shadow-card sm:p-design-4"
      aria-label={t("filter.formAria")}
    >
      {/* Redesign (2026-10-07): one toolbar. Five fields in a grid that is one column on a phone,
          two on a tablet and one row on a desk, with the actions at the end of the row. */}
      <div className="grid grid-cols-1 items-end gap-design-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(9.5rem,0.9fr)_minmax(9.5rem,0.9fr)_auto]">
        <Field id="filter-status" label={t("filter.status")}>
          <select id="filter-status" name="status" defaultValue={value.status} className={fieldStyles}>
            <option value="">{t("filter.allStatuses")}</option>
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {tStatus(`statusLabels.${statusKey(s)}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field id="filter-type" label={t("filter.damageType")}>
          <select id="filter-type" name="type" defaultValue={value.type} className={fieldStyles}>
            <option value="">{t("filter.allTypes")}</option>
            {DAMAGE_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {DAMAGE_CATEGORY_KEYS.has(opt) ? tReport(`step3.${opt}`) : opt}
              </option>
            ))}
          </select>
        </Field>

        <Field id="filter-division" label={t("filter.dsDivision")}>
          <input
            id="filter-division"
            name="division"
            type="text"
            defaultValue={value.division}
            placeholder={t("filter.divisionPlaceholder")}
            className={`${fieldStyles} placeholder:text-ink-secondary`}
          />
        </Field>

        <Field id="filter-from" label={t("filter.from")}>
          <input id="filter-from" name="from" type="date" defaultValue={value.from} className={fieldStyles} />
        </Field>

        <Field id="filter-to" label={t("filter.to")}>
          <input id="filter-to" name="to" type="date" defaultValue={value.to} className={fieldStyles} />
        </Field>

        <div className="flex gap-design-2 sm:col-span-2 xl:col-span-1">
          <button type="submit" className={`${buttonStyles.primary} flex-1 xl:flex-none`}>
            <Funnel aria-hidden="true" size={16} />
            {t("filter.apply")}
          </button>
          <button type="button" onClick={onClear} className={buttonStyles.quiet}>
            {t("filter.clear")}
          </button>
        </div>
      </div>

      {/* Final governance workflow: organise the queue by whether a field officer has verified the
          report, and by the officer responsible for it. */}
      <details className="group mt-design-3" open={advancedCount > 0}>
        <summary className="inline-flex cursor-pointer list-none items-center gap-design-1 rounded-sm text-caption font-medium text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest [&::-webkit-details-marker]:hidden">
          <CaretDown aria-hidden="true" size={14} className="transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
          {t("filter.more")}
          {advancedCount > 0 && (
            <span className="rounded-sm bg-forest-pale px-1.5 text-caption font-semibold tabular-nums text-forest">
              {advancedCount}
            </span>
          )}
        </summary>
        <div className="mt-design-3 grid grid-cols-1 gap-design-3 sm:grid-cols-2 xl:max-w-[640px]">
          <Field id="filter-assessment" label={t("filter.assessment")}>
            <select id="filter-assessment" name="assessment" defaultValue={value.assessment} className={fieldStyles}>
              <option value="">{t("filter.assessmentAll")}</option>
              <option value="assessed">{t("filter.assessmentAssessed")}</option>
              <option value="pending">{t("filter.assessmentPending")}</option>
            </select>
          </Field>

          <Field id="filter-officer" label={t("filter.officer")}>
            <input
              id="filter-officer"
              name="officer"
              type="text"
              defaultValue={value.officer}
              placeholder={t("filter.officerPlaceholder")}
              className={`${fieldStyles} placeholder:text-ink-secondary`}
            />
          </Field>
        </div>
      </details>
    </form>
  );
}

/** Label above its control. Never a placeholder standing in for a label. */
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-design-1">
      <label htmlFor={id} className="text-caption font-medium text-ink-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
