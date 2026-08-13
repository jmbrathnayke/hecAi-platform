"use client";

import { useLocale } from "next-intl";
import { useRouter, usePathname } from "@/navigation";
import { LocaleButtonGroup, type LocaleCode } from "@/components/LocaleButtonGroup";

// Citizen-portal (routed) language selector. Lives under app/[locale], so switching is a
// locale-aware route replace. The button markup/list is shared with the non-routed officer/admin
// selector via LocaleButtonGroup (Story 6.1).
export function LanguageSelector({ compact = false }: { compact?: boolean } = {}) {
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

  return <LocaleButtonGroup current={current} onSelect={switchLocale} compact={compact} />;
}
