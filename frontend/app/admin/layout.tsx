import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { fontVariables } from "@/lib/fonts";
import { resolveStaffLocale, loadMessages } from "@/lib/serverLocale";
import { AdminShell } from "@/components/admin/AdminShell";

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
  title: "HEC Platform — Admin Portal",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} className={fontVariables}>
      {/* suppressHydrationWarning: browser extensions (Grammarly et al.) mutate <body>'s
          attributes before hydration. Scoped to this element only — see app/[locale]/layout.tsx. */}
      <body className="font-sans" suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AdminShell>{children}</AdminShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
