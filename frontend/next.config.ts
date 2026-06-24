import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

// Content hash so precached static assets (which are NOT fingerprinted in their URL) are
// re-fetched when their contents change across deploys, instead of being served stale.
const rev = (path: string): string =>
  createHash("md5").update(readFileSync(path)).digest("hex").slice(0, 8);

const withSerwist = withSerwistInit({
  // swSrc points to the TypeScript SOURCE — serwist compiles it to swDest.
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Disable the Service Worker in dev so HMR is not cached; enabled in production builds.
  disable: process.env.NODE_ENV === "development",
  // Explicitly precache the web app manifest and icons (the app shell is precached
  // automatically from the Next.js build output).
  additionalPrecacheEntries: [
    { url: "/manifest.json", revision: rev("public/manifest.json") },
    { url: "/icons/icon-192.png", revision: rev("public/icons/icon-192.png") },
    { url: "/icons/icon-512.png", revision: rev("public/icons/icon-512.png") },
  ],
});

const nextConfig: NextConfig = {};

// Both plugins must wrap the config: serwist (PWA) on the outside, next-intl (i18n) on the inside.
export default withSerwist(withNextIntl(nextConfig));
