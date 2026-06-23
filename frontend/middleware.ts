import createMiddleware from "next-intl/middleware";

export default createMiddleware({
  locales: ["si", "ta", "en"],
  defaultLocale: "si",
});

export const config = {
  // Match all paths except Next.js internals and static files
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
