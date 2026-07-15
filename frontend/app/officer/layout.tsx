import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { fontVariables } from "@/lib/fonts";
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
  title: "HEC Platform — Officer Portal",
};

export default async function OfficerLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} className={fontVariables}>
      <body className="font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SyncStatusBar />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
