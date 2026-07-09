import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { routing } from "./routing";

const intlMiddleware = createMiddleware(routing);

export default async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Admin routes (Story 5.1) — English-only (FR-9.3, no locale prefix) AND session-protected.
  // Path-boundary + case-insensitive match so /administrator, /admin-x, etc. are NOT treated as
  // admin (defense-in-depth; Next.js route resolution is case-sensitive too). /admin/login is
  // excluded from the gate to avoid a redirect loop. This is session-PRESENCE only (any
  // authenticated Supabase user) — role enforcement is the backend's job (require_admin()) plus
  // the login page's own role check, matching the officer precedent exactly (don't add a
  // role-checking branch officer's middleware doesn't have).
  const lowerPath = path.toLowerCase();
  const isAdminRoute = lowerPath === "/admin" || lowerPath.startsWith("/admin/");
  const isAdminLogin = lowerPath === "/admin/login" || lowerPath.startsWith("/admin/login/");
  if (isAdminRoute && !isAdminLogin) {
    let response = NextResponse.next({ request });
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    });
    // getUser() (not getSession()) — revalidates the token against Supabase Auth rather than
    // trusting an unverified locally-decoded cookie (CRITICAL #2). Fail closed (redirect) on any
    // network/Supabase failure, never an unhandled error page (CRITICAL #7).
    let user = null;
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch {
      user = null;
    }
    if (!user) {
      // Carry over any cookie mutations setAll() already wrote (e.g. clearing an invalid session
      // cookie) — a bare redirect would silently drop them, leaving a stale cookie in the browser.
      const redirect = NextResponse.redirect(new URL("/admin/login", request.url));
      response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
      return redirect;
    }
    return response;
  }
  if (isAdminRoute) {
    // /admin/login itself — English-only, but no session gate (would loop). Skip locale logic.
    return NextResponse.next();
  }

  // Officer routes — also English-only, no locale prefix, and session-protected.
  // Path-boundary match so /officerx etc. isn't treated as an officer route. Compared
  // case-insensitively (defense-in-depth) — Next.js's own route resolution is also
  // case-sensitive, so a case-differing path can't reach real page content either way,
  // but this keeps the auth gate itself from being the weaker link.
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
    // Authenticated — run intl handling for the locale-prefixed page, but carry over any session
    // cookies Supabase rotated during getUser(). Returning a bare intl response would drop them
    // and log the citizen out near a token refresh (the Story 3.1 middleware cookie-carry lesson).
    const intlResponse = intlMiddleware(request);
    response.cookies.getAll().forEach((cookie) => intlResponse.cookies.set(cookie));
    return intlResponse;
  }

  return intlMiddleware(request);
}

export const config = {
  // Match all paths except Next.js internals, API routes, and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
