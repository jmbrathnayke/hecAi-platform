import { cookies } from "next/headers";
import { routing } from "@/routing";

// Non-routed locale resolution for the officer/admin surfaces (Story 6.1). These surfaces live
// OUTSIDE the app/[locale] route group, so next-intl's requestLocale (which is derived from the
// [locale] route segment) is undefined here and always falls back to routing.defaultLocale
// ("si"). Instead we read the locale from the NEXT_LOCALE cookie -- next-intl's own persistence
// key, the same one components/LanguageSelector.tsx and the non-routed selector write -- so the
// choice is honored server-side (SSR-correct <html lang>, no flash-of-wrong-language).
//
// Fallback is "en", NOT routing.defaultLocale: the DWC officer/admin surfaces default to English
// for staff (Story 6.1 AC2 / CRITICAL #4), unlike the rural-citizen portal which defaults to si.
// A real cookie value of any of the three locales is still honored, so a user who chose Sinhala
// anywhere keeps it across surfaces.
const STAFF_FALLBACK_LOCALE = "en";

type Locale = (typeof routing.locales)[number];

function isValidLocale(value: string | undefined): value is Locale {
  return value !== undefined && routing.locales.includes(value as Locale);
}

/** Resolve the active locale for a non-routed (officer/admin) surface from the NEXT_LOCALE cookie. */
export async function resolveStaffLocale(): Promise<Locale> {
  const value = (await cookies()).get("NEXT_LOCALE")?.value;
  return isValidLocale(value) ? value : STAFF_FALLBACK_LOCALE;
}

/** Load the messages bundle for a resolved locale (mirrors i18n.ts's dynamic import). */
export async function loadMessages(locale: Locale) {
  return (await import(`../messages/${locale}.json`)).default;
}
