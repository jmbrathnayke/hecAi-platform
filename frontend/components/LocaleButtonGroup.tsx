"use client";

// Shared presentational language buttons (Story 6.1). The routed citizen selector
// (LanguageSelector.tsx) and the non-routed officer/admin selector (LanguageSelectorCookie.tsx)
// differ only in HOW they apply the choice (route replace vs. cookie + refresh); the button list,
// labels, and styling are identical, so they live here once instead of being duplicated.
export const LOCALES = [
  { code: "si", label: "සිංහල" },
  { code: "ta", label: "தமிழ்" },
  { code: "en", label: "English" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export function LocaleButtonGroup({
  current,
  onSelect,
  compact = false,
}: {
  current: string;
  onSelect: (code: LocaleCode) => void;
  /**
   * Tighter horizontal padding + caption type, for the citizen home's language BAR (the mockup
   * puts the label and all three pills on one row). Deliberately does NOT shrink the height:
   * the mockup's ~24px pills would break the 48px touch-target floor the rest of the app holds
   * to, so `min-h-touch-target` stays on both variants.
   */
  compact?: boolean;
}) {
  return (
    <div className="flex gap-design-2 justify-center" role="group" aria-label="Language selection">
      {LOCALES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => onSelect(code)}
          aria-pressed={current === code}
          lang={code}
          className={`${
            compact ? "px-design-2 text-caption" : "px-design-4 text-label"
          } py-design-2 rounded-sm font-medium min-h-touch-target transition-colors ${
            current === code
              ? "bg-forest-pale border-2 border-forest text-forest"
              : "bg-surface-raised border border-border-default text-ink-secondary hover:border-forest-mid"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
