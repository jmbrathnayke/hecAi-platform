import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./routing";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  // Admin routes are always served in English (FR-9.3) — skip locale negotiation entirely so
  // they never get a /si|/ta|/en prefix. (Admin pages arrive in Sprint 5.)
  // Path-boundary match so /administrator, /admin-x, etc. are NOT treated as admin.
  const path = request.nextUrl.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) {
    return NextResponse.next();
  }
  return intlMiddleware(request);
}

export const config = {
  // Match all paths except Next.js internals, API routes, and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
