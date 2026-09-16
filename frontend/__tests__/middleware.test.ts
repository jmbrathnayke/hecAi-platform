/**
 * @jest-environment node
 */
// Officer route protection (Story 3.1). Verifies the /officer/* bypass mirrors the existing
// /admin bypass (no locale prefix) and enforces a server-verified session — using getUser()
// (not getSession()) per CRITICAL #2, since getSession() only decodes the cookie locally and
// is not proof of a currently-valid session.
import { NextRequest, NextResponse } from "next/server";

// NOTE: jest.mock factories run before any outer `const` in this file is initialized (only
// jest.mock calls + real ES imports are hoisted, plain consts are not) — so factories must not
// close over outer consts. `mockGetUser` is only invoked lazily inside the officer-route branch
// (at request-handling time, long after this file finishes loading), so it's safe to reference;
// the intl-middleware factory below deliberately stays self-contained for the same reason.
const mockGetUser = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createServerSupabaseClient: (cookies: { setAll?: (c: unknown[]) => void }) => {
    // Stash the cookie adapter middleware.ts passed in so tests can simulate the Supabase
    // SDK calling setAll() (e.g. to refresh/clear a session cookie) during getUser().
    (globalThis as unknown as { __capturedCookies: unknown }).__capturedCookies = cookies;
    return { auth: { getUser: (...a: unknown[]) => mockGetUser(...a) } };
  },
}));

jest.mock("next-intl/middleware", () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn(() => require("next/server").NextResponse.next())),
}));

import createIntlMiddleware from "next-intl/middleware";
import middleware from "../middleware";

function innerIntlMiddleware() {
  return (createIntlMiddleware as unknown as jest.Mock).mock.results[0].value as jest.Mock;
}

beforeEach(() => {
  mockGetUser.mockReset();
  innerIntlMiddleware().mockClear();
});

test("unauthenticated officer route redirects to /officer/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/officer/login");
});

test("authenticated officer route passes through", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "officer-1" } } });
  const req = new NextRequest(new URL("http://localhost/officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
});

test("/officer/login itself is not protected (no redirect loop)", async () => {
  const req = new NextRequest(new URL("http://localhost/officer/login"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(mockGetUser).not.toHaveBeenCalled();
});

// OAuth PKCE callback. Two ways middleware could break it: session-gating it (a permanent loop,
// since creating the session is its job) or handing it to intlMiddleware (which would 307 it to
// /si/auth/callback and drop the ?code the exchange needs).
test("/auth/callback reaches its handler ungated and unlocalized", async () => {
  const req = new NextRequest(new URL("http://localhost/auth/callback?code=abc-123"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("/auth/callback/ (trailing slash) is bypassed too, so the ?code is not 307'd away", async () => {
  // The bypass was an exact match while every other route family in middleware.ts matches both
  // the bare and the slash-suffixed form. The near-miss fell through to intlMiddleware and got
  // redirected to /si/auth/callback/, dropping the code (code review 2026-08-13).
  const req = new NextRequest(new URL("http://localhost/auth/callback/?code=abc-123"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("/officerx (boundary, not an officer route) is not treated as protected", async () => {
  const req = new NextRequest(new URL("http://localhost/officerx"));
  await middleware(req);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).toHaveBeenCalled();
});

// Admin route protection (Story 5.1). Mirrors the officer block: /admin/* is English-only (never
// routed through next-intl) AND session-gated, /admin/login excluded, boundary-matched.
test("unauthenticated admin route redirects to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/admin/cases"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/admin/login");
});

test("authenticated admin route passes through, never routed to next-intl (English-only)", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  const req = new NextRequest(new URL("http://localhost/admin/cases"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("/admin/login itself is not protected (no redirect loop) and is not localized", async () => {
  const req = new NextRequest(new URL("http://localhost/admin/login"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("/adminx (boundary, not an admin route) is not treated as protected", async () => {
  const req = new NextRequest(new URL("http://localhost/adminx"));
  await middleware(req);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).toHaveBeenCalled();
});

test("getUser() failure on an admin route fails closed with a redirect to /admin/login", async () => {
  mockGetUser.mockRejectedValue(new Error("network down"));
  const req = new NextRequest(new URL("http://localhost/admin/cases"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/admin/login");
});

test("case-differing admin path (/Admin/cases) is still gated, not bypassed", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/Admin/cases"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/admin/login");
});

test("non-admin, non-officer routes still go through next-intl middleware", async () => {
  const req = new NextRequest(new URL("http://localhost/report"));
  await middleware(req);
  expect(innerIntlMiddleware()).toHaveBeenCalledWith(req);
});

test("getUser() failure does not throw — fails closed with a redirect", async () => {
  mockGetUser.mockRejectedValue(new Error("network down"));
  const req = new NextRequest(new URL("http://localhost/officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/officer/login");
});

test("case-differing officer path (/Officer/dashboard) is still gated, not bypassed", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/Officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/officer/login");
});

test("cookies written via setAll() during getUser() propagate onto the success response", async () => {
  mockGetUser.mockImplementation(() => {
    const cookies = (globalThis as unknown as { __capturedCookies: { setAll: (c: unknown[]) => void } })
      .__capturedCookies;
    cookies.setAll([{ name: "sb-refreshed", value: "new-token", options: {} }]);
    return Promise.resolve({ data: { user: { id: "officer-1" } } });
  });
  const req = new NextRequest(new URL("http://localhost/officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.cookies.get("sb-refreshed")?.value).toBe("new-token");
});

test("cookies written via setAll() during a failed getUser() still propagate onto the redirect response", async () => {
  mockGetUser.mockImplementation(() => {
    const cookies = (globalThis as unknown as { __capturedCookies: { setAll: (c: unknown[]) => void } })
      .__capturedCookies;
    // Simulates Supabase clearing an invalid/expired session cookie before reporting no user.
    cookies.setAll([{ name: "sb-refreshed", value: "", options: {} }]);
    return Promise.resolve({ data: { user: null } });
  });
  const req = new NextRequest(new URL("http://localhost/officer/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  // Before the fix, returning a bare NextResponse.redirect() here would silently drop this.
  expect(res.cookies.get("sb-refreshed")?.value).toBe("");
});

// ============================================================ Divisional Secretariat (Story 8.5)
//
// REGRESSION GUARD. Story 8.5 shipped app/ds/layout.tsx and app/ds/dashboard/page.tsx but no
// middleware exemption, so every /ds/* request fell through to intlMiddleware, was 307'd to
// /si/ds/dashboard — a path with no route under app/[locale] — and 404'd. The dashboard was
// unreachable for the entire life of the story, and no test caught it: the page component renders
// correctly in isolation, and only requesting the route through a running server reveals it.
//
// These assert the same contract the officer block has, so the two cannot drift apart again.

test("unauthenticated DS route redirects to /ds/login, NOT into the locale tree", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/ds/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  // The bug produced http://localhost/si/ds/dashboard here.
  expect(res.headers.get("location")).toBe("http://localhost/ds/login");
});

test("the DS route never reaches the intl middleware", async () => {
  // This is the assertion that would have caught the original defect.
  mockGetUser.mockResolvedValue({ data: { user: { id: "ds-1" } } });
  const req = new NextRequest(new URL("http://localhost/ds/dashboard"));
  await middleware(req);
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("authenticated DS route passes through", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "ds-1" } } });
  const req = new NextRequest(new URL("http://localhost/ds/dashboard"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
});

test("/ds/login itself is not protected (no redirect loop)", async () => {
  const req = new NextRequest(new URL("http://localhost/ds/login"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(mockGetUser).not.toHaveBeenCalled();
});

test("/dsx (boundary, not a DS route) is not treated as protected", async () => {
  // Same boundary discipline as /officerx: a prefix match without the separator would gate
  // unrelated paths and, worse, exempt them from localisation.
  const req = new NextRequest(new URL("http://localhost/dsx"));
  await middleware(req);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).toHaveBeenCalled();
});

// ============================================================ System Administration (FR-11)
//
// Added with the tree, not after it. /ds shipped without its exemption and 404'd for the whole
// life of Story 8.5; these assertions exist so /system cannot repeat that.

test("unauthenticated system route redirects to /system/login, NOT into the locale tree", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const req = new NextRequest(new URL("http://localhost/system/users"));
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/system/login");
});

test("the system route never reaches the intl middleware", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "sys-1" } } });
  const req = new NextRequest(new URL("http://localhost/system/users"));
  await middleware(req);
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
});

test("authenticated system route passes through", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "sys-1" } } });
  const res = await middleware(new NextRequest(new URL("http://localhost/system/users")));
  expect(res.status).toBe(200);
});

test("/system/login itself is not protected (no redirect loop)", async () => {
  const res = await middleware(new NextRequest(new URL("http://localhost/system/login")));
  expect(res.status).toBe(200);
  expect(mockGetUser).not.toHaveBeenCalled();
});

test("/systemx (boundary) is not treated as a system route", async () => {
  await middleware(new NextRequest(new URL("http://localhost/systemx")));
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).toHaveBeenCalled();
});
