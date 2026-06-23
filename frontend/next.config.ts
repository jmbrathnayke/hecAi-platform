import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

const nextConfig: NextConfig = {
  // serwist PWA plugin is added in Story 1.2
};

export default withNextIntl(nextConfig);
