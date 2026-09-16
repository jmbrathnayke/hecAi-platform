import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { routing } from "./routing";

const intlMiddleware = createMiddleware(routing);

export default async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // RER-7 measurement harness (2026-08-11) — not a product route. Unprefixed and unlocalized,
  // like /admin and /officer, otherwise intlMiddleware 307s it to /si/rer7-harness and the
  // Playwright runner never reaches the page. Gated on the same build-time flag as the page
  // itself, so a production build (flag unset) falls through to normal locale handling and the
  // route resolves to nothing.
  if (
    process.env.NEXT_PUBLIC_ENABLE_RER7_HARNESS === "1" &&
    path.toLowerCase() === "/rer7-harness"
  ) {
    return NextResponse.next();
  }

  // Admin routes (Story 5.1) — English-only (FR-9.3, no locale prefix) AND session-protected.
  // Path-boundary + case-insensitive match so /administrator, /admin-x, etc. are NOT treated as
  // admin (defense-in-depth; Next.js route resolution is case-sensitive too). /admin/login is
  // excluded from the gate to avoid a redirect loop. This is session-PRESENCE only (any
  // authenticated Supabase user) — role enforcement is the backend's job (require_admin()) plus
  // the login page's own role check, matching the officer precedent exactly (don't add a
  // role-checking branch officer's middleware doesn't have).
  const lowerPath = path.toLowerCase();

  // OAuth PKCE callback — a Route Handler, not a page, and it must reach its handler untouched.
  // It cannot be session-gated (creating the session is its entire job, so gating it would be a
  // permanent redirect loop), and it must skip intlMiddleware, which would 307 it to
  // /si/auth/callback and drop the ?code in the process.
  // Matched with the trailing-slash form too, like every other route family in this file: an
  // exact-only comparison let /auth/callback/ fall through to intlMiddleware and get 307'd to
  // /si/auth/callback/, dropping the ?code — precisely the failure this bypass prevents.
  if (lowerPath === "/auth/callback" || lowerPath.startsWith("/auth/callback/")) {
    return NextResponse.next();
  }

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

  // Divisional Secretariat routes (Story 8.5) — same shape as /officer and /admin: a separate
  // top-level tree with no locale prefix, session-protected, English path with the locale coming
  // from the NEXT_LOCALE cookie inside app/ds/layout.tsx.
  //
  // WITHOUT THIS BLOCK THE DS DASHBOARD IS UNREACHABLE. /ds/* falls through to intlMiddleware,
  // which 307s it to /si/ds/dashboard — a route that does not exist under app/[locale] — so every
  // request 404s. Story 8.5 added app/ds/ but not the middleware exemption its siblings have, and
  // no test caught it because the page component renders correctly in isolation; only requesting
  // the route through the running app reveals it.
  const isDsRoute = lowerPath === "/ds" || lowerPath.startsWith("/ds/");
  const isDsLogin = lowerPath === "/ds/login" || lowerPath.startsWith("/ds/login/");
  if (isDsRoute && !isDsLogin) {
    let response = NextResponse.next({ request });
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    });
    // getUser(), not getSession(): it revalidates against Supabase Auth rather than trusting a
    // locally-decoded cookie. Role enforcement stays the backend's job (require_ds_officer())
    // plus the login page's own check — this gate only establishes that someone is signed in.
    let user = null;
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch {
      user = null;
    }
    if (!user) {
      // Carry over cookie mutations setAll() already wrote (e.g. clearing an expired session),
      // which a bare redirect would drop.
      const redirect = NextResponse.redirect(new URL("/ds/login", request.url));
      response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
      return redirect;
    }
    return response;
  }
  if (isDsRoute) {
    return NextResponse.next();
  }

  // System Administrator routes (FR-11) — same shape again. Added at the same time as the tree
  // itself, because /ds shipped without this block and 404'd for the whole life of Story 8.5:
  // anything under app/ that is not app/[locale] needs an exemption here or intlMiddleware 307s
  // it into the locale tree, where it has no route.
  const isSystemRoute = lowerPath === "/system" || lowerPath.startsWith("/system/");
  const isSystemLogin = lowerPath === "/system/login" || lowerPath.startsWith("/system/login/");
  if (isSystemRoute && !isSystemLogin) {
    let response = NextResponse.next({ request });
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    });
    // Establishes only that someone is signed in. The system_admin role itself is enforced by
    // require_system_admin() on every provisioning call — a client-side check would be advisory,
    // and this surface is the one where advisory is not good enough.
    let user = null;
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch {
      user = null;
    }
    if (!user) {
      const redirect = NextResponse.redirect(new URL("/system/login", request.url));
      response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
      return redirect;
    }
    return response;
  }
  if (isSystemRoute) {
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
