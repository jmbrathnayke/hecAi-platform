import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { OfficerAppBar } from "@/components/OfficerAppBar";
import { OfficerBottomNav } from "@/components/OfficerBottomNav";
import { SWRegistrar } from "@/components/SWRegistrar";
import { fontVariables, staffFontVariables } from "@/lib/fonts";
import { resolveStaffLocale, loadMessages } from "@/lib/serverLocale";

// Officer routes are a separate top-level tree from app/[locale] (no locale route prefix) --
// Next.js requires each top-level branch under app/ to reach its own <html>/<body> via a layout
// in its chain, so this is a second, independent root layout (not nested under app/[locale]).
//
// Story 6.1 (FR-9.3 revised): brought to si/ta/en parity via a NON-ROUTED i18n provider. Locale
// is read from the NEXT_LOCALE cookie server-side (resolveStaffLocale, fallback "en" for staff)
// so <html lang> and the loaded messages are SSR-correct with no flash. Bulk string extraction
// is Story 6.2 -- this layout only establishes the provider + fonts + <html lang>.
export const metadata: Metadata = {
  title: "HEC Field Officer",
};

export default async function OfficerLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    // flex column + flex-1 content wrapper pins OfficerBottomNav to the bottom of short pages
    // (same structure as the citizen layout).
    <html lang={locale} className={`${fontVariables} ${staffFontVariables}`}>
      {/* suppressHydrationWarning: browser extensions (Grammarly et al.) mutate <body>'s
          attributes before hydration. Scoped to this element only — see app/[locale]/layout.tsx. */}
      <body className="flex min-h-dvh flex-col bg-surface-base font-staff antialiased" suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {/* Mounted here as well as in app/[locale]/layout.tsx. This is a SEPARATE root layout,
              so anything mounted only there never runs on /officer/* — and the officer tree is
              precisely the offline-first one. Without this an officer who logs in at
              /officer/login and stays inside /officer/* never registers the Service Worker, so
              the MobileNetV2 precache that FR-2.5 depends on never happens and IndexedDB is
              never initialised. It also means the dev-mode teardown of a stale worker never
              fired on the pages where the stale model was actually being served. */}
          <SWRegistrar />
          <SyncStatusBar />
          {/* The persistent app bar (redesign, 2026-10-07): brand, language and the bell, in place
              of the strip that held only the bell. SyncStatusBar above it still appears only while
              syncing or on error. */}
          <OfficerAppBar />
          <div className="flex flex-1 flex-col">{children}</div>
          <OfficerBottomNav />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
