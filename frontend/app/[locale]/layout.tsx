import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { SWRegistrar } from "@/components/SWRegistrar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { CitizenBottomNav } from "@/components/CitizenBottomNav";
import { fontVariables } from "@/lib/fonts";
import { routing } from "@/routing";
import "../globals.css";

export const metadata: Metadata = {
  title: "HEC Platform",
  description: "Human-Elephant Conflict AI E-Governance Platform",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#2D6A4F",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Reject unknown locale segments (e.g. /admin, /xyz) with a 404 instead of rendering the
  // citizen home in a fallback locale. Admin routes (Sprint 5) live at /admin, not /[locale].
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound();
  }
  const messages = await getMessages();
  return (
    // `flex min-h-dvh flex-col` + a `flex-1` content wrapper is what lets CitizenBottomNav sit
    // at the bottom of the viewport on short pages instead of floating directly under the
    // content. min-h-dvh (not min-h-screen) so mobile browser chrome collapsing doesn't leave
    // the bar hanging mid-screen.
    <html lang={locale} className={fontVariables}>
      {/* suppressHydrationWarning is scoped to <body>'s OWN attributes (it does not cascade to
          children, so genuine mismatches inside the app still surface). Browser extensions —
          Grammarly injects data-gr-ext-installed / data-new-gr-c-s-check-loaded here — mutate
          <body> before React hydrates, producing an unfixable warning that is not our bug and
          would otherwise train everyone to ignore hydration warnings that ARE ours. */}
      <body className="flex min-h-dvh flex-col font-sans" suppressHydrationWarning>
        <SWRegistrar />
        <NextIntlClientProvider messages={messages}>
          <OfflineBanner />
          <div className="flex flex-1 flex-col">{children}</div>
          <CitizenBottomNav />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
