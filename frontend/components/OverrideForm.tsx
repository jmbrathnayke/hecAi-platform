"use client";

// AI classification override form (Story 3.4, FR-2.4, UX-DR14). Mounted from the officer
// classify page onto AIResultCard's `onOverride` seam — the card itself is never modified.
// Officer portal is English-only (FR-9.3), so labels are hardcoded English matching the
// AIResultCard / officer-login convention. 48px touch targets throughout.
//
// The override selector offers exactly the 3 model classes (ClassId). `combined` is a derived
// case-level rollup, NOT a selectable per-photo class, so it never appears here.

import { useState } from "react";
import type { ClassId } from "@/lib/mobilenet";

// Canonical label mapping lives in AIResultCard.tsx; re-declared identically here (rather than
// importing) to honor the "do not modify AIResultCard.tsx" guardrail. Keep the two in lockstep.
const CATEGORY_LABELS: Record<ClassId, string> = {
  crop_damage: "Crop Damage",
  no_damage: "No Damage",
  property_damage: "Property Damage",
};

// Fixed order of the 3 selectable model classes.
const CATEGORY_OPTIONS: ClassId[] = ["crop_damage", "no_damage", "property_damage"];

// UX-DR14: reason must be at least 10 non-whitespace characters before Confirm enables.
const MIN_REASON_LENGTH = 10;

export interface OverrideFormProps {
  currentCategory: ClassId;
  onConfirm: (category: ClassId, reason: string) => void;
  onCancel: () => void;
}

export function OverrideForm({ currentCategory, onConfirm, onCancel }: OverrideFormProps) {
  // Preselect the AI's prediction so the officer only changes it when they disagree.
  const [category, setCategory] = useState<ClassId>(currentCategory);
  const [reason, setReason] = useState("");

  const trimmedLength = reason.trim().length;
  const reasonValid = trimmedLength >= MIN_REASON_LENGTH;
  const canConfirm = reasonValid; // category always has a value (preselected)

  return (
    <section
      data-testid="override-form"
      aria-label="Override AI classification"
      className="border-l-4 border-forest bg-surface-raised rounded-md p-design-4 space-y-design-4"
    >
      <h2 className="text-headline text-ink-primary">Override classification</h2>

      <fieldset className="space-y-design-2">
        <legend className="text-label text-ink-secondary">Correct category</legend>
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
            <span className="text-label text-ink-primary">{CATEGORY_LABELS[option]}</span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-design-2">
        <label htmlFor="override-reason" className="text-label text-ink-secondary">
          Reason for override
        </label>
        <textarea
          id="override-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-forest-pale bg-surface-base p-design-3 text-label text-ink-primary"
          placeholder="Explain why the AI classification is incorrect"
        />
        <div className="flex items-center justify-between">
          <span
            data-testid="override-reason-count"
            className="text-caption text-ink-secondary"
          >
            {trimmedLength}/{MIN_REASON_LENGTH} characters
          </span>
          {!reasonValid && (
            <span role="note" className="text-caption text-status-warning">
              Please provide a more detailed reason
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-design-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 min-h-touch-target border border-forest text-forest text-label font-semibold rounded-md"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(category, reason.trim())}
          disabled={!canConfirm}
          className="flex-1 min-h-touch-target bg-forest text-ink-on-dark text-label font-semibold rounded-md disabled:opacity-60"
        >
          Confirm Override
        </button>
      </div>
    </section>
  );
}
