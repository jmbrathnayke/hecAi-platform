"use client";

import { useLocale } from "next-intl";
import { useRouter, usePathname } from "@/navigation";

const LOCALES = [
  { code: "si", label: "සිංහල" },
  { code: "ta", label: "தமிழ்" },
  { code: "en", label: "English" },
] as const;

type LocaleCode = (typeof LOCALES)[number]["code"];

export function LanguageSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const current = useLocale();

  function switchLocale(locale: LocaleCode) {
    if (locale === current) return; // already the active locale — nothing to do

    // Mirror the choice to localStorage. Persistence itself is driven by next-intl's
    // NEXT_LOCALE cookie (set on navigation); this mirror is for any client-side reads.
    try {
      localStorage.setItem("hec-locale", locale);
    } catch {
      // localStorage may be unavailable (e.g. private mode) — non-fatal.
    }

    // Preserve query string + hash (next-intl's usePathname() excludes them).
    const suffix =
      typeof window !== "undefined" ? window.location.search + window.location.hash : "";
    // Client-side navigation to the same page in the new locale — no full page reload.
    router.replace(`${pathname}${suffix}`, { locale });
  }

  return (
    <div
      className="flex gap-design-2 justify-center"
      role="group"
      aria-label="Language selection"
    >
      {LOCALES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => switchLocale(code)}
          aria-pressed={current === code}
          lang={code}
          className={`px-design-4 py-design-2 rounded-sm text-label font-medium min-h-touch-target transition-colors ${
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
