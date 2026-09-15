import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import "../globals.css";
import { fontVariables } from "@/lib/fonts";
import { resolveStaffLocale, loadMessages } from "@/lib/serverLocale";

// System Administrator routes (FR-11) — a separate top-level tree from app/[locale], like
// app/officer, app/admin and app/ds, so the URL carries no locale prefix. Locale comes from the
// NEXT_LOCALE cookie server-side, which keeps <html lang> and the loaded messages SSR-correct.
//
// No SWRegistrar, for the same reason app/ds omits it: this is a desk surface with reliable
// connectivity. It needs neither the offline shell nor the MobileNetV2 precache, and registering a
// Service Worker here would cache an administrative surface for no benefit.
export const metadata: Metadata = {
  title: "HEC Platform — System Administration",
};

export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveStaffLocale();
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} className={fontVariables}>
      {/* suppressHydrationWarning: browser extensions mutate <body>'s attributes before hydration.
          Scoped to this element only — same as the other root layouts. */}
      <body className="flex min-h-dvh flex-col font-sans" suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <div className="flex-1">{children}</div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
