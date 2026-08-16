"use client";

// Field notes (officer-camera.html mockup screen 2: "Field notes (optional)" above the
// Accept / Override CTAs). EXPERIENCE.md § Officer Chamara, step 9: after accepting the AI
// result he adds "Approx 1.5 acres of paddy affected, east section of field."
//
// SCOPE (2026-08-14): the note is persisted to the IndexedDB draft only. There is no
// `field_notes` column on `cases`, no field on the submit payload, and no reader on the admin
// case-detail panel — so the note survives a reload and a step-back, but does NOT reach the
// server yet. EXPERIENCE.md § Case Detail expects it to appear under the photo carousel for the
// reviewing admin; wiring that end-to-end is a migration + API + admin-UI change, tracked
// separately. The label deliberately says "optional" and promises nothing about delivery.
//
// PII note: this is free text an officer types about a field, not about a person. It is NOT
// encrypted the way reporter_nic / reporter_mobile are (lib/crypto), so the placeholder steers
// toward describing the damage rather than the claimant.

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { updateDraft } from "@/lib/indexeddb";
import { getOrCreateDraftId } from "@/lib/draft";

/** Long enough for the mockup's two-line note plus room; short enough to stay a "note". */
const MAX_LENGTH = 500;
/** Debounce before writing. A draft write per keystroke would thrash IndexedDB on a slow device. */
const SAVE_DEBOUNCE_MS = 600;

export interface FieldNotesProps {
  /** Initial text, if the host page already read it off the draft. */
  initialValue?: string;
  /** Notified after each successful persist, so the host can mirror it into its own review step. */
  onSaved?: (value: string) => void;
}

export function FieldNotes({ initialValue = "", onSaved }: FieldNotesProps) {
  const t = useTranslations("officer");
  const [value, setValue] = useState(initialValue);
  const [saveFailed, setSaveFailed] = useState(false);
  const mountedRef = useRef(true);
  // Held in a ref so the debounce effect below does not have to list it as a dependency and
  // restart the timer every time the host re-renders with a new closure.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // Skips the write on the very first render: without it, mounting the component would persist
  // `initialValue` straight back over itself on every visit to the step.
  const dirtyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = setTimeout(() => {
      const draftId = getOrCreateDraftId();
      updateDraft(draftId, { field_notes: value })
        .then(() => {
          if (!mountedRef.current) return;
          setSaveFailed(false);
          onSavedRef.current?.(value);
        })
        .catch(() => {
          // The text is still on screen and still in React state — the officer has not lost it,
          // and the next keystroke retries. Surface it quietly rather than as a blocking error.
          if (mountedRef.current) setSaveFailed(true);
        });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <div className="space-y-design-1">
      <label htmlFor="officer-field-notes" className="block text-caption text-ink-disabled">
        {t("fieldNotes.label")}
      </label>
      <textarea
        id="officer-field-notes"
        data-testid="field-notes"
        rows={3}
        maxLength={MAX_LENGTH}
        value={value}
        placeholder={t("fieldNotes.placeholder")}
        onChange={(e) => {
          dirtyRef.current = true;
          setValue(e.target.value);
        }}
        className="w-full rounded-md border border-border-default bg-surface-raised p-design-3 text-body leading-relaxed text-ink-primary"
      />
      <div className="flex items-start justify-between gap-design-3">
        {saveFailed ? (
          <p role="alert" className="text-caption text-status-warning">
            {t("fieldNotes.saveError")}
          </p>
        ) : (
          <span />
        )}
        <span className="shrink-0 text-caption text-ink-disabled">
          {t("fieldNotes.count", { count: value.length, max: MAX_LENGTH })}
        </span>
      </div>
    </div>
  );
}
