/**
 * @jest-environment node
 */
// OAuth PKCE callback (/auth/callback). This route is the half of signInWithOAuth() that was
// missing entirely: without it the provider's `?code=` is never exchanged for session cookies and
// every Google sign-in bounces straight back to the login page.
import { NextRequest } from "next/server";

const mockExchange = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createServerSupabaseClient: (cookies: {
    setAll?: (c: { name: string; value: string; options?: unknown }[]) => void;
  }) => {
    // Stash the cookie adapter so a test can simulate the SDK writing session cookies during the
    // exchange, and assert they survive onto the redirect response.
    (globalThis as unknown as { __capturedCookies: typeof cookies }).__capturedCookies = cookies;
    return { auth: { exchangeCodeForSession: (...a: unknown[]) => mockExchange(...a) } };
  },
}));

import { GET } from "../route";

function capturedCookies() {
  return (
    globalThis as unknown as {
      __capturedCookies: { setAll: (c: { name: string; value: string; options?: unknown }[]) => void };
    }
  ).__capturedCookies;
}

// The real exchangeCodeForSession() resolves { data: { session }, error }. Mocking only `error`
// let the route's "no error means success" assumption go untested -- the route now also requires
// an actual session, since redirecting without one lands the user on a protected page with no
// cookies and middleware bounces them back with no error at all (code review 2026-08-13).
const A_SESSION = { access_token: "at", refresh_token: "rt", user: { id: "u-1" } };

beforeEach(() => {
  mockExchange.mockReset().mockResolvedValue({ data: { session: A_SESSION }, error: null });
});

test("exchanges the code and redirects to the requested destination", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);

  expect(mockExchange).toHaveBeenCalledWith("abc-123");
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/officer/dashboard");
});

test("session cookies written during the exchange survive onto the redirect response", async () => {
  // The cookie-carry trap: building the redirect AFTER the exchange would discard everything
  // setAll() wrote, leaving the user redirected but still unauthenticated.
  mockExchange.mockImplementation(async () => {
    capturedCookies().setAll([
      { name: "sb-test-auth-token", value: "session-value", options: { path: "/" } },
    ]);
    return { data: { session: A_SESSION }, error: null };
  });

  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);

  expect(res.cookies.get("sb-test-auth-token")?.value).toBe("session-value");
  expect(res.headers.get("location")).toBe("http://localhost/officer/dashboard");
});

// The rejection fallback is "/" and deliberately NOT an officer path: an admin whose `next` went
// missing would otherwise be sent to /officer/dashboard, admitted by middleware (they do hold a
// session), then shown a 403 by require_officer() with no route onward.
test("an absolute off-origin `next` is refused (open-redirect guard)", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=https%3A%2F%2Fevil.example%2Fsteal"),
  );
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/");
});

test("a protocol-relative `next` is refused (browsers normalize //host to a host)", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2F%2Fevil.example%2Fsteal"),
  );
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/");
});

test("a backslash-prefixed `next` is refused", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2F%5Cevil.example%2Fsteal"),
  );
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/");
});

test("a provider error redirects to the login page for the intended surface, without exchanging", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?error=access_denied&next=%2Fadmin%2Fcases"),
  );
  const res = await GET(req);

  expect(mockExchange).not.toHaveBeenCalled();
  expect(res.headers.get("location")).toBe("http://localhost/admin/login?error=access_denied");
});

test("a missing code redirects to login rather than attempting an exchange", async () => {
  const req = new NextRequest(new URL("http://localhost/auth/callback?next=%2Fofficer%2Fdashboard"));
  const res = await GET(req);

  expect(mockExchange).not.toHaveBeenCalled();
  expect(res.headers.get("location")).toBe("http://localhost/officer/login?error=missing_code");
});

test("a failed exchange redirects to login instead of leaving the user on a dead page", async () => {
  mockExchange.mockResolvedValue({ error: { message: "invalid code" } });
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=stale&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/officer/login?error=exchange_failed");
});

test("an unreachable Supabase fails closed to login, not an unhandled error page", async () => {
  mockExchange.mockRejectedValue(new Error("ENOTFOUND"));
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/officer/login?error=unreachable");
});

test("a citizen destination bounces to the unprefixed /login on failure (intl adds the locale)", async () => {
  const req = new NextRequest(new URL("http://localhost/auth/callback?error=access_denied&next=%2Fmy-cases"));
  const res = await GET(req);
  expect(res.headers.get("location")).toBe("http://localhost/login?error=access_denied");
});

// --- Code review 2026-08-13 ----------------------------------------------------------------

test("an exchange that reports no error but yields no session is treated as a failure", async () => {
  // "No error" is not "session created". Returning the success redirect without one puts the user
  // on a protected page with no cookies, where middleware bounces them back to login with NO
  // error at all -- the silent no-op this route exists to eliminate, one step later.
  mockExchange.mockResolvedValue({ data: { session: null }, error: null });

  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);

  expect(res.headers.get("location")).toBe("http://localhost/officer/login?error=exchange_failed");
});

test("cookies written before a failed exchange survive onto the login redirect", async () => {
  // A failed exchange makes the SDK clear/rewrite the PKCE verifier cookie. Dropping that write
  // leaves the stale verifier in the browser, so the NEXT attempt reuses it and fails too -- a
  // login loop only manual cookie-clearing escapes.
  mockExchange.mockImplementation(async () => {
    capturedCookies().setAll([
      { name: "sb-test-auth-token-code-verifier", value: "", options: { path: "/", maxAge: 0 } },
    ]);
    return { data: { session: null }, error: { message: "invalid code" } };
  });

  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=stale&next=%2Fofficer%2Fdashboard"),
  );
  const res = await GET(req);

  expect(res.headers.get("location")).toBe("http://localhost/officer/login?error=exchange_failed");
  expect(res.cookies.get("sb-test-auth-token-code-verifier")?.value).toBe("");
});

test("an unrecognized provider error is collapsed to a generic code, never reflected", async () => {
  // /auth/callback is reachable with no OAuth round-trip, so `error` is attacker-controlled.
  // Reflecting it verbatim onto our own login page is a first-party phishing surface.
  const hostile = encodeURIComponent("Session expired, call IT on 077-1234567");
  const req = new NextRequest(
    new URL(`http://localhost/auth/callback?error=${hostile}&next=%2Fofficer%2Fdashboard`),
  );
  const res = await GET(req);

  const location = res.headers.get("location") ?? "";
  expect(location).toBe("http://localhost/officer/login?error=oauth_error");
  expect(location).not.toContain("077-1234567");
});

test("a known provider error code is passed through unchanged", async () => {
  const req = new NextRequest(
    new URL("http://localhost/auth/callback?error=access_denied&next=%2Fadmin%2Fcases"),
  );
  const res = await GET(req);

  expect(res.headers.get("location")).toBe("http://localhost/admin/login?error=access_denied");
  expect(mockExchange).not.toHaveBeenCalled();
});

test("a client that cannot be constructed fails closed to the login page, not an error page", async () => {
  // createServerSupabaseClient() throws when the public Supabase env vars are missing or
  // mis-scoped. Constructed outside the try, that surfaced as a Next.js error page mid-OAuth with
  // the ?code already burned.
  mockExchange.mockImplementation(() => {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  });

  const req = new NextRequest(
    new URL("http://localhost/auth/callback?code=abc-123&next=%2Fadmin%2Fcases"),
  );
  const res = await GET(req);

  expect(res.headers.get("location")).toBe("http://localhost/admin/login?error=unreachable");
});
