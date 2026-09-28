import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";

// OAuth PKCE callback — the missing half of signInWithOAuth().
//
// `@supabase/ssr`'s browser client uses the PKCE flow: signInWithOAuth() hands the browser to the
// provider, and the provider returns to `redirectTo` with `?code=<uuid>`. That code is NOT a
// session — it must be exchanged server-side for one, and only exchangeCodeForSession() writes the
// `sb-<ref>-auth-token` cookies that middleware and Server Components read. Pointing `redirectTo`
// straight at a protected page (as both login pages originally did) means no exchange ever runs:
// middleware finds no session, redirects back to /login, and the ?code is silently dropped —
// a sign-in that appears to do nothing at all.
//
// The exchange must happen on the SERVER (not in a client component) because the session cookies
// have to be attached to an HTTP response. The PKCE code verifier is readable here because
// createBrowserClient stored it in a cookie (`sb-<ref>-auth-token-code-verifier`) rather than
// localStorage — that cookie-backed storage is the whole reason the SSR client exists.
//
// Middleware lets /auth/callback through untouched; see the bypass in middleware.ts.

/**
 * Error codes this route is willing to put in a URL, mapped from whatever the provider sent.
 *
 * `?error=` is attacker-controllable — /auth/callback is reachable with no OAuth round-trip behind
 * it — so reflecting the raw value onto our own login page turns it into a first-party phishing
 * surface ("Session expired, call IT on 077-..."), or worse if the page ever renders it as HTML.
 * Everything unrecognized collapses to a single generic code (code review 2026-08-13).
 */
const ALLOWED_PROVIDER_ERRORS = new Set([
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

function safeErrorCode(raw: string): string {
  return ALLOWED_PROVIDER_ERRORS.has(raw) ? raw : "oauth_error";
}

// Email sign-in links verified here by token_hash rather than via Supabase's /verify redirect, which
// can only return to the site root (the one allowlisted URL) where nothing exchanges a session.
type EmailLinkType = "magiclink" | "email";

function emailLinkType(raw: string | null): EmailLinkType | null {
  return raw === "magiclink" || raw === "email" ? raw : null;
}

/**
 * Login page to bounce back to when the exchange fails, inferred from the intended destination.
 *
 * EVERY staff tree must be listed. A tree that is missing falls through to the citizen login, so a
 * Divisional Secretariat officer whose sign-in fails is deposited on /en/login — a page whose only
 * control emails a one-time code to a citizen account, with no route back to the portal they were
 * trying to enter and no indication of what went wrong. /ds was missing from this list for the
 * whole life of Story 8.5, and /system would have repeated it.
 *
 * This is the third place that enumerates the staff trees, after middleware.ts and the login pages
 * themselves. Adding a fourth tree means editing all three.
 */
function loginPathFor(next: string): string {
  if (next.startsWith("/admin")) return "/admin/login";
  if (next.startsWith("/officer")) return "/officer/login";
  if (next.startsWith("/ds")) return "/ds/login";
  if (next.startsWith("/system")) return "/system/login";
  // Citizen login is locale-prefixed (/si|/ta|/en/login); the unprefixed form is resolved by
  // next-intl's middleware on the follow-up request.
  return "/login";
}

/**
 * Resolve the post-login destination, rejecting anything that would leave this origin.
 *
 * Without this the callback is an open redirect: an attacker could send a victim to
 * /auth/callback?next=https://evil.example and land a freshly-authenticated browser there.
 * Parsing against our own origin and then comparing origins also defeats the protocol-relative
 * (`//evil.example`) and backslash (`/\evil.example`) forms that browsers normalize to a host.
 *
 * The fallback is deliberately "/" and NOT an officer path: an admin whose `next` went missing
 * (Supabase's redirect allowlist can match on base URL and drop the query) would otherwise be sent
 * to /officer/dashboard, admitted by middleware because they do hold a session, and then shown a
 * 403 from require_officer() with no route onward (code review 2026-08-13).
 */
function safeNext(raw: string | null, origin: string, fallback: string): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin !== origin) return fallback;
    return parsed.pathname + parsed.search;
  } catch {
    return fallback;
  }
}

/**
 * A redirect whose `Location` is RELATIVE, and that is not a style choice.
 *
 * Behind Azure App Service's front-end proxy the container is addressed internally, so
 * `request.nextUrl.origin` resolves to `https://localhost:8080` — the port the Node process listens
 * on — rather than the public hostname. Every absolute redirect built from that origin sent the
 * browser to `https://localhost:8080/system/users` and the sign-in died there, on the live domain,
 * with no error: the whole OAuth round-trip succeeds and then lands nowhere.
 *
 * `Location` is explicitly permitted to be a relative reference (RFC 7231 §7.1.2) and the browser
 * resolves it against the URL it actually requested — which is the only party that reliably knows
 * the public origin. This is also why next-intl's middleware redirects were unaffected while this
 * route broke: it emits relative paths.
 *
 * Deriving the origin from `X-Forwarded-Host` instead would work only for as long as the platform
 * keeps sending it, and would silently regress to the same dead end if it ever stopped. Not
 * naming an origin at all cannot be wrong.
 */
function relativeRedirect(pathAndQuery: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: pathAndQuery } });
}

/**
 * Redirect to a login page, carrying over any cookies already written onto `response`.
 *
 * The cookie carry is not cosmetic. A failed exchange makes the SDK clear or rewrite the PKCE
 * verifier cookie (`sb-<ref>-auth-token-code-verifier`); returning a fresh NextResponse silently
 * discards that write, so the stale verifier survives in the browser and the NEXT sign-in attempt
 * reuses it and fails too — a login loop only manual cookie-clearing escapes. middleware.ts solves
 * the same problem the same way (code review 2026-08-13).
 */
function redirectToLogin(
  next: string,
  origin: string,
  errorCode: string,
  carryFrom?: NextResponse,
): NextResponse {
  // Built through URL for correct query encoding, then emitted relative — see relativeRedirect().
  const back = new URL(loginPathFor(next), origin);
  back.searchParams.set("error", errorCode);
  const redirect = relativeRedirect(back.pathname + back.search);
  carryFrom?.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"), origin, "/");

  // The provider can return an error instead of a code — most commonly the user declining consent
  // on Google's screen. That is a normal outcome, not a crash: send them back to the login page
  // they started from with a flag the page can surface.
  const providerError = searchParams.get("error");
  if (providerError) {
    return redirectToLogin(next, origin, safeErrorCode(providerError));
  }

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const linkType = emailLinkType(searchParams.get("type"));
  const emailLink = tokenHash && linkType ? { token_hash: tokenHash, type: linkType } : null;
  if (!code && !emailLink) {
    // Someone reached /auth/callback directly, with no OAuth round-trip behind it.
    return redirectToLogin(next, origin, "missing_code");
  }

  // Build the success response FIRST so the Supabase SDK's setAll() can write the session cookies
  // onto the very response that carries the redirect. Creating the redirect afterwards would
  // discard them — the same cookie-carry trap middleware.ts documents.
  //
  // `next` is already a validated path+query from safeNext(), so it is emitted as-is.
  const response = relativeRedirect(next);

  let exchangeFailed: string | null = null;
  try {
    // Inside the try: createServerSupabaseClient() throws when the public Supabase env vars are
    // missing or mis-scoped (a real possibility on a fresh preview deployment). Constructing it
    // outside meant that threw mid-OAuth and surfaced as a Next.js error page with the ?code
    // already burned, instead of failing closed to the login page (code review 2026-08-13).
    const supabase = createServerSupabaseClient({
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    });

    const { data, error } = emailLink
      ? await supabase.auth.verifyOtp(emailLink)
      : await supabase.auth.exchangeCodeForSession(code as string);
    if (error) {
      // The URL deliberately carries only a generic code (see safeErrorCode), but the SERVER log
      // must carry the real reason or this failure is undiagnosable: "exchange_failed" is the same
      // string whether the PKCE verifier cookie was absent, the code was already spent, or the
      // callback URL is missing from the provider's redirect allowlist — three different fixes.
      console.error(
        emailLink ? "[auth/callback] verifyOtp failed:" : "[auth/callback] exchangeCodeForSession failed:",
        error.message,
        "| status:", error.status,
        "| next:", next,
        "| verifier cookie present:",
        request.cookies.getAll().some((c) => c.name.includes("code-verifier")),
      );
      exchangeFailed = "exchange_failed";
    } else if (!data?.session) {
      // "No error" is not the same as "session created". Returning the success redirect without
      // one lands the user on a protected page with no cookies, where middleware bounces them
      // back to login with NO error at all — reintroducing the silent no-op this route exists to
      // eliminate, one step later (code review 2026-08-13).
      exchangeFailed = "exchange_failed";
    }
  } catch {
    // Network failure reaching Supabase Auth, or a misconfigured client. Fail closed to the login
    // page rather than letting an unhandled rejection surface as a Next.js error page.
    exchangeFailed = "unreachable";
  }

  if (exchangeFailed) {
    return redirectToLogin(next, origin, exchangeFailed, response);
  }

  return response;
}
