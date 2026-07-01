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
  // Path-boundary match so /officerx etc. isn't treated as an officer route.
  const isOfficerRoute = path === "/officer" || path.startsWith("/officer/");
  const isOfficerLogin = path === "/officer/login" || path.startsWith("/officer/login/");
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
      return NextResponse.redirect(new URL("/officer/login", request.url));
    }
    return response;
  }
  if (isOfficerRoute) {
    return NextResponse.next();
  }

  return intlMiddleware(request);
}

export const config = {
  // Match all paths except Next.js internals, API routes, and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
