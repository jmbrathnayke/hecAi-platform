import type { Metadata, Viewport } from "next";
import { Noto_Sans, Noto_Sans_Sinhala, Noto_Sans_Tamil } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { SWRegistrar } from "@/components/SWRegistrar";
import "../globals.css";

// Self-hosted by next/font at build time → served from same origin and precached by the
// Service Worker (part of the app-shell build output), so Sinhala/Tamil text renders offline.
const notoSans = Noto_Sans({
  subsets: ["latin"],
  variable: "--font-noto-sans",
  display: "swap",
});
const notoSansSinhala = Noto_Sans_Sinhala({
  subsets: ["sinhala"],
  variable: "--font-noto-sinhala",
  display: "swap",
});
const notoSansTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-noto-tamil",
  display: "swap",
});

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
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={`${notoSans.variable} ${notoSansSinhala.variable} ${notoSansTamil.variable}`}
    >
      <body className="font-sans">
        <SWRegistrar />
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
