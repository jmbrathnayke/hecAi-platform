import { defineRouting } from "next-intl/routing";

// Single source of truth for locales — used by middleware, navigation, and i18n request config.
// localeDetection (default true) negotiates via the NEXT_LOCALE cookie (set when the user picks a
// language) then the Accept-Language header, so a returning visitor lands in their last locale.
export const routing = defineRouting({
  locales: ["si", "ta", "en"],
  defaultLocale: "si",
});
