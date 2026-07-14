import { Noto_Sans, Noto_Sans_Sinhala, Noto_Sans_Tamil } from "next/font/google";

// Shared Noto Sans font instances (Story 6.1). Extracted from app/[locale]/layout.tsx so all
// three root layouts -- citizen (app/[locale]), officer (app/officer), admin (app/admin) -- can
// set the same --font-* CSS variables that tailwind.config.ts's `font-sans` depends on. Without
// these variables on a surface's <html>, Sinhala/Tamil text falls back to a browser default font
// (Story 6.1 AC4). next/font must be called at module scope, which a shared module satisfies.
//
// Self-hosted by next/font at build time -> served from same origin and precached by the Service
// Worker (part of the app-shell build output), so Sinhala/Tamil text renders offline.
export const notoSans = Noto_Sans({
  subsets: ["latin"],
  variable: "--font-noto-sans",
  display: "swap",
});

export const notoSansSinhala = Noto_Sans_Sinhala({
  subsets: ["sinhala"],
  variable: "--font-noto-sinhala",
  display: "swap",
});

export const notoSansTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-noto-tamil",
  display: "swap",
});

// The className string that sets all three CSS variables on an <html> element.
export const fontVariables = `${notoSans.variable} ${notoSansSinhala.variable} ${notoSansTamil.variable}`;
