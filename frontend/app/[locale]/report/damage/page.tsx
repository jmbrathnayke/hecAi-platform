"use client";
// Step 3 of the incident form: damage category (single choice) + optional description.
// The stored value is the category KEY (crop|property|combined|none), never the
// localized label (CRITICAL #1).
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { DamageCard } from "@/components/DamageCard";
import { getCase, updateDraft } from "@/lib/indexeddb";
import { getDraftId } from "@/lib/draft";

const DAMAGE_CATEGORIES = ["crop", "property", "combined", "none"] as const;
type DamageCategory = (typeof DAMAGE_CATEGORIES)[number];
const MAX_DESCRIPTION = 500;

export default function DamageStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const [selected, setSelected] = useState<DamageCategory | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Restore prior selection/description (e.g. returning from Step 4); redirect to
  // Step 1 if there is no draft (deep link / lost sessionStorage).
  useEffect(() => {
    const draftId = getDraftId();
    if (!draftId) {
      router.replace("/report");
      return;
    }
    let active = true;
    getCase(draftId)
      .then((draft) => {
        if (!active || !draft) return;
        if (typeof draft.damage_category === "string") {
          setSelected(draft.damage_category as DamageCategory);
        }
        if (typeof draft.description === "string") setDescription(draft.description);
      })
      .catch(() => {
        /* a fresh draft simply has no fields yet */
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function handleNext() {
    if (saving) return;
    if (!selected) {
      setError(t("step3.selectError"));
      return;
    }
    const draftId = getDraftId();
    if (!draftId) {
      router.replace("/report");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await updateDraft(draftId, { damage_category: selected, description });
      router.push("/report/photos");
    } catch {
      setSaveError(t("step3.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const remaining = MAX_DESCRIPTION - description.length;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
      <StepIndicator steps={steps} currentStep={2} />

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("step3.title")}</h1>
      </header>

      <div
        role="radiogroup"
        aria-label={t("step3.title")}
        className="grid grid-cols-2 gap-design-3"
      >
        {DAMAGE_CATEGORIES.map((cat) => (
          <DamageCard
            key={cat}
            category={cat}
            label={t(`step3.${cat}`)}
            selected={selected === cat}
            onSelect={() => {
              setSelected(cat);
              setError(null);
            }}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-design-2">
        <label htmlFor="description" className="text-label font-medium text-ink-primary">
          {t("step3.description")}
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
          placeholder={t("step3.descriptionPlaceholder")}
          rows={4}
          maxLength={MAX_DESCRIPTION}
          className="resize-none rounded-md border border-border-default bg-surface-raised px-design-3 py-design-2 text-body text-ink-primary focus:border-border-focus focus:outline-none"
        />
        <p className="text-right text-caption text-ink-disabled">
          {t("step3.charsRemaining", { remaining })}
        </p>
      </div>

      {saveError && (
        <p role="alert" className="text-caption text-status-error">
          {saveError}
        </p>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleNext()}
        className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {t("step3.next")}
      </button>
    </main>
  );
}
