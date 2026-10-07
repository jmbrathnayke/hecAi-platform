"use client";

// AI classification override form (Story 3.4, FR-2.4, UX-DR14). Mounted from the officer
// classify page onto AIResultCard's `onOverride` seam — the card itself is never modified.
// Localized si/ta/en (Story 6.2, FR-9.1) via the officer i18n provider — the 3 class labels are
// read from the same `officer.aiResult.*` keys AIResultCard uses (kept in lockstep). 48px touch
// targets throughout.
//
// The override selector offers exactly the 3 model classes (ClassId). `combined` is a derived
// case-level rollup, NOT a selectable per-photo class, so it never appears here.

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ClassId } from "@/lib/mobilenet";

// Fixed order of the 3 selectable model classes. Labels come from `officer.aiResult.<classId>`
// (the same keys AIResultCard renders) so the two stay in lockstep automatically.
const CATEGORY_OPTIONS: ClassId[] = ["crop_damage", "no_damage", "property_damage"];

// UX-DR14: reason must be at least 10 non-whitespace characters before Confirm enables.
const MIN_REASON_LENGTH = 10;

export interface OverrideFormProps {
  currentCategory: ClassId;
  onConfirm: (category: ClassId, reason: string) => void;
  onCancel: () => void;
}

export function OverrideForm({ currentCategory, onConfirm, onCancel }: OverrideFormProps) {
  const t = useTranslations("officer");
  // Preselect the AI's prediction so the officer only changes it when they disagree.
  const [category, setCategory] = useState<ClassId>(currentCategory);
  const [reason, setReason] = useState("");

  const trimmedLength = reason.trim().length;
  const reasonValid = trimmedLength >= MIN_REASON_LENGTH;
  const canConfirm = reasonValid; // category always has a value (preselected)

  return (
    <section
      data-testid="override-form"
      aria-label={t("override.formLabel")}
      className="border-l-4 border-forest bg-surface-raised rounded-md p-design-4 space-y-design-4 shadow-card"
    >
      <h2 className="text-headline text-ink-primary">{t("override.title")}</h2>

      <fieldset className="space-y-design-2">
        <legend className="text-label text-ink-secondary">{t("override.correctCategory")}</legend>
        {CATEGORY_OPTIONS.map((option) => (
          <label
            key={option}
            className="flex items-center gap-design-3 min-h-touch-target cursor-pointer"
          >
            <input
              type="radio"
              name="override-category"
              value={option}
              checked={category === option}
              onChange={() => setCategory(option)}
              className="h-5 w-5 accent-forest"
            />
            <span className="text-label text-ink-primary">{t(`aiResult.${option}`)}</span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-design-2">
        <label htmlFor="override-reason" className="text-label text-ink-secondary">
          {t("override.reasonLabel")}
        </label>
        <textarea
          id="override-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full rounded-sm border border-border-default bg-surface-raised p-design-3 text-label text-ink-primary focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest-pale"
          placeholder={t("override.reasonPlaceholder")}
        />
        <div className="flex items-center justify-between">
          <span
            data-testid="override-reason-count"
            className="text-caption text-ink-secondary"
          >
            {t("override.charCount", { count: trimmedLength, min: MIN_REASON_LENGTH })}
          </span>
          {!reasonValid && (
            <span role="note" className="text-caption text-status-warning">
              {t("override.reasonHint")}
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-design-3">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-touch-target flex-1 items-center justify-center rounded-sm border border-border-subtle bg-surface-raised px-design-4 text-label font-semibold text-ink-primary transition-[background-color,border-color,transform] duration-150 hover:border-border-default hover:bg-surface-base active:scale-[0.98] motion-reduce:transition-none"
        >
          {t("override.cancel")}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(category, reason.trim())}
          disabled={!canConfirm}
          className="inline-flex flex-1 min-h-touch-target items-center justify-center rounded-sm bg-forest px-design-4 text-label font-semibold text-ink-on-dark transition-[background-color,transform] duration-150 hover:bg-forest-mid active:scale-[0.98] disabled:opacity-60 motion-reduce:transition-none"
        >
          {t("override.confirm")}
        </button>
      </div>
    </section>
  );
}
