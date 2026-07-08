import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { routing } from "./routing";

const intlMiddleware = createMiddleware(routing);

export default async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Admin routes are always served in English (FR-9.3) — skip locale negotiation entirely so
  // they never get a /si|/ta|/en prefix. (Admin pages arrive in Sprint 5.)
  // Path-boundary match so /administrator, /admin-x, etc. are NOT treated as admin.
  if (path === "/admin" || path.startsWith("/admin/")) {
    return NextResponse.next();
  }

  // Officer routes — also English-only, no locale prefix, and session-protected.
  // Path-boundary match so /officerx etc. isn't treated as an officer route. Compared
  // case-insensitively (defense-in-depth) — Next.js's own route resolution is also
  // case-sensitive, so a case-differing path can't reach real page content either way,
  // but this keeps the auth gate itself from being the weaker link.
  const lowerPath = path.toLowerCase();
  const isOfficerRoute = lowerPath === "/officer" || lowerPath.startsWith("/officer/");
  const isOfficerLogin = lowerPath === "/officer/login" || lowerPath.startsWith("/officer/login/");
  if (isOfficerRoute && !isOfficerLogin) {
    let response = NextResponse.next({ request });
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    });
    // getUser() (not getSession()) — it revalidates the token against Supabase Auth rather
    // than trusting an unverified locally-decoded cookie, matching this story's CRITICAL #2
    // "never trust client-sent claims without independent validation".
    // A network/Supabase failure here must fail closed (redirect), not throw an unhandled
    // error that would surface as a Next.js error page for the officer (CRITICAL #7).
    let user = null;
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch {
      user = null;
    }
    if (!user) {
      // Carry over any cookie mutations setAll() already wrote (e.g. clearing an
      // invalid/expired session cookie) — returning a bare redirect would silently drop
      // them, leaving the stale cookie in the browser across the redirect.
      const redirect = NextResponse.redirect(new URL("/officer/login", request.url));
      response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
      return redirect;
    }
    return response;
  }
  if (isOfficerRoute) {
    return NextResponse.next();
  }

  // Citizen account routes (Story 4.0) — localized and session-protected. ONLY the "My Cases"
  // account view is gated; report/* and status/* stay public so anonymous reporting is unaffected.
  // Matches the locale-prefixed form (/si|/ta|/en/my-cases…); an unprefixed /my-cases is first
  // locale-redirected by intlMiddleware, then re-enters here prefixed.
  const citizenMatch = lowerPath.match(/^\/(si|ta|en)\/my-cases(\/|$)/);
  if (citizenMatch) {
    const routeLocale = citizenMatch[1];
    let response = NextResponse.next({ request });
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    });
    // getUser() revalidates against Supabase Auth (never trusts an unverified cookie); fail closed.
    let user = null;
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch {
      user = null;
    }
    if (!user) {
      const redirect = NextResponse.redirect(new URL(`/${routeLocale}/login`, request.url));
      response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
      return redirect;
    }
    // Authenticated — still run intl handling for the locale-prefixed page.
    return intlMiddleware(request);
  }

  return intlMiddleware(request);
}

export const config = {
  // Match all paths except Next.js internals, API routes, and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
