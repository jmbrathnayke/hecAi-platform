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
  createServerSupabaseClient: () => ({ auth: { getUser: (...a: unknown[]) => mockGetUser(...a) } }),
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

test("/officerx (boundary, not an officer route) is not treated as protected", async () => {
  const req = new NextRequest(new URL("http://localhost/officerx"));
  await middleware(req);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).toHaveBeenCalled();
});

test("/admin routes are still bypassed unaffected by officer logic", async () => {
  const req = new NextRequest(new URL("http://localhost/admin/cases"));
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(innerIntlMiddleware()).not.toHaveBeenCalled();
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
