import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { SWRegistrar } from "@/components/SWRegistrar";
import { OfflineBanner } from "@/components/OfflineBanner";
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
    <html lang={locale} className={fontVariables}>
      <body className="font-sans">
        <SWRegistrar />
        <NextIntlClientProvider messages={messages}>
          <OfflineBanner />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
