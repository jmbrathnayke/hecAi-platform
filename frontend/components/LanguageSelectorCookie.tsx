"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { LocaleButtonGroup, type LocaleCode } from "@/components/LocaleButtonGroup";

// Non-routed language selector for the officer/admin surfaces (Story 6.1). These surfaces live
// outside app/[locale], so there is no locale route segment to replace. Instead the choice is
// written to the NEXT_LOCALE cookie (next-intl's own persistence key -- the same one the routed
// citizen selector relies on) plus the hec-locale localStorage mirror, then router.refresh()
// re-renders the Server Component layout (which reads the cookie via resolveStaffLocale) so the
// whole surface switches language with no full page reload.
//
// Note: useRouter here is next/navigation's (App Router refresh), NOT @/navigation's
// (locale-aware route replace) -- these surfaces are not locale-routed.
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function LanguageSelectorCookie({ segmented = false }: { segmented?: boolean } = {}) {
  const router = useRouter();
  const current = useLocale();

  function switchLocale(locale: LocaleCode) {
    if (locale === current) return; // already active — nothing to do

    // Primary persistence: the NEXT_LOCALE cookie the server layout reads (resolveStaffLocale).
    document.cookie = `NEXT_LOCALE=${locale};path=/;max-age=${ONE_YEAR_SECONDS};SameSite=Lax`;

    // Client-readable mirror, same key the citizen selector uses.
    try {
      localStorage.setItem("hec-locale", locale);
    } catch {
      // localStorage may be unavailable (e.g. private mode) — non-fatal.
    }

    // Re-render the Server Component layout so it re-reads the cookie — no full page reload.
    router.refresh();
  }

  return <LocaleButtonGroup current={current} onSelect={switchLocale} segmented={segmented} />;
}
