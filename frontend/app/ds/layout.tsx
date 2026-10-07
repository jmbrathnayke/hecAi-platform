import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { fontVariables, staffFontVariables } from "@/lib/fonts";
import { resolveStaffLocale, loadMessages } from "@/lib/serverLocale";
import { StaffTopBar } from "@/components/StaffTopBar";

// Divisional Secretariat routes are a separate top-level tree from app/[locale] (no locale route
// prefix), so — like app/officer and app/admin — this is an independent root layout reaching its
// own <html>/<body>. See app/officer/layout.tsx for the same reasoning at length.
//
// Trilingual from the first commit. The Epic 6 correct-course exists because /officer and /admin
// were built English-only and had to be retrofitted; this surface does not repeat that. Locale
// comes from the NEXT_LOCALE cookie server-side (resolveStaffLocale), so <html lang> and the
// loaded messages are SSR-correct with no flash.
//
// Deliberately NO SWRegistrar: the DS office works from a desktop with reliable connectivity
// (PRD Section 3), so it needs neither the offline shell nor the MobileNetV2 precache that make
// the officer tree offline-first. Registering a Service Worker here would cache an admin-style
// surface for no benefit.
export const metadata: Metadata = {
  title: "HEC Divisional Secretariat",
};

export default async function DsLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} className={`${fontVariables} ${staffFontVariables}`}>
      {/* suppressHydrationWarning: browser extensions mutate <body>'s attributes before
          hydration. Scoped to this element only — same as the other root layouts. */}
      <body className="flex min-h-dvh flex-col bg-surface-base font-staff antialiased" suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <StaffTopBar tree="ds" />
          <div className="flex-1">{children}</div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
