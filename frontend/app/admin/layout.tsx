import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { fontVariables, staffFontVariables } from "@/lib/fonts";
import { resolveStaffLocale, loadMessages } from "@/lib/serverLocale";
import { AdminShell } from "@/components/admin/AdminShell";
import { SWRegistrar } from "@/components/SWRegistrar";

// Admin routes are a separate top-level tree from app/[locale] (no locale route prefix),
// mirroring the officer tree. Next.js requires each top-level branch under app/ to reach its own
// <html>/<body> via a layout in its chain, so this is an independent root layout (not nested
// under app/[locale]). No SyncStatusBar here -- offline sync is an officer field-app concern,
// not an admin desk concern.
//
// Story 6.1 (FR-9.3 revised): brought to si/ta/en parity via a NON-ROUTED i18n provider. Locale
// is read from the NEXT_LOCALE cookie server-side (resolveStaffLocale, fallback "en" for staff)
// so <html lang> and the loaded messages are SSR-correct with no flash. Bulk string extraction
// is Story 6.3 -- this layout only establishes the provider + fonts + <html lang>.
export const metadata: Metadata = {
  title: "HEC Admin",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} className={`${fontVariables} ${staffFontVariables}`}>
      {/* suppressHydrationWarning: browser extensions (Grammarly et al.) mutate <body>'s
          attributes before hydration. Scoped to this element only — see app/[locale]/layout.tsx. */}
      <body className="font-staff antialiased" suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {/* Same reason as the officer tree: this is a separate root layout. Admin is an
              online desk app, so the offline precache is not the point here — but a stale
              Service Worker from an earlier production build controls the whole ORIGIN, and
              without this the dev-mode teardown never runs on /admin/* either. */}
          <SWRegistrar />
          <AdminShell>{children}</AdminShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
