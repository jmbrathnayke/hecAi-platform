"use client";

// Officer login (Story 3.1). Localized si/ta/en (Story 6.2, FR-9.1) via the officer i18n
// provider (Story 6.1) — lives outside app/[locale] so its URL stays unprefixed. Supabase
// auth error messages are passed through verbatim (they are provider-owned, not app copy).

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient, isAuthReachable } from "@/lib/supabase";
import { callbackErrorKey } from "@/lib/authErrors";

type SupabaseClient = ReturnType<typeof createClient>;

// useSearchParams() requires a Suspense boundary (Next.js App Router) or the build fails with a
// static-bailout error — same treatment as admin/cases (Story 5.3). The fallback is null: the only
// thing searchParams contributes here is a post-redirect error banner, so there is nothing
// meaningful to render while suspended.
export default function OfficerLoginPage() {
  return (
    <Suspense fallback={null}>
      <OfficerLoginPageContent />
    </Suspense>
  );
}

function OfficerLoginPageContent() {
  const t = useTranslations("officer");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Lazy-init: createClient() must NOT run during SSR prerender (env vars may be absent in CI).
  // The ref starts null and is populated on first access, which only happens in browser event
  // handlers — never during the server render pass.
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const getSupabase = useCallback(() => {
    if (!supabaseRef.current) {
      supabaseRef.current = createClient();
    }
    return supabaseRef.current;
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Guards state updates after the async sign-in resolves post-unmount (Epic 2 retro lesson —
  // async work racing against component unmount was the single most common defect class).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface a failed OAuth round-trip. app/auth/callback/route.ts bounces failures back here with
  // ?error=<code>; without this the user sees a blank login form and no explanation at all.
  useEffect(() => {
    const key = callbackErrorKey(searchParams.get("error"));
    if (key) setError(t(key));
  }, [searchParams, t]);

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      // Advisory preflight: signInWithOAuth() never reports an unreachable Auth host (it only
      // builds a URL and redirects), so without this the officer would be handed to the browser's
      // own "site can't be reached" page having seen nothing from the app.
      //
      // It WARNS and continues rather than blocking (code review 2026-08-13): a cross-origin
      // fetch cannot distinguish a genuine outage from a CORS rejection or an ad-blocker, so
      // treating a false result as authoritative would lock officers out of a healthy Supabase.
      // If the host really is down the redirect fails anyway — with the warning already shown.
      if (!(await isAuthReachable()) && mountedRef.current) {
        setError(t("login.networkError"));
      }
      const { error: signInError } = await getSupabase().auth.signInWithOAuth({
        provider: "google",
        // Must return to /auth/callback, NOT straight to the dashboard: the provider comes back
        // with a PKCE `?code=` that only a server-side exchangeCodeForSession() can turn into
        // session cookies. Redirecting to the protected page directly meant middleware saw no
        // session and bounced the officer back here with the code discarded.
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/officer/dashboard")}`,
        },
      });
      if (!mountedRef.current) return;
      if (signInError) {
        setError(signInError.message);
      }
      // On success the browser navigates to Google; nothing else to do here.
    } catch {
      if (mountedRef.current) setError(t("login.networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: signInError } = await getSupabase().auth.signInWithPassword({
        email,
        password,
      });
      if (!mountedRef.current) return;
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.push("/officer/dashboard");
    } catch {
      if (mountedRef.current) setError(t("login.networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-surface-base flex items-center justify-center px-design-4">
      <div className="w-full max-w-sm bg-surface-raised rounded-lg border border-border-default p-design-6 space-y-design-4">
        <h1 className="text-title text-ink-primary text-center">{t("login.title")}</h1>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={submitting}
          className="w-full min-h-touch-target bg-forest text-ink-on-dark text-label font-semibold rounded-md disabled:opacity-60"
        >
          {t("login.google")}
        </button>

        <div className="relative text-center text-ink-disabled text-label">
          <span className="bg-surface-raised px-design-2">{t("login.or")}</span>
        </div>

        <form onSubmit={handleEmailSignIn} className="space-y-design-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("login.emailPlaceholder")}
            required
            className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("login.passwordPlaceholder")}
            required
            className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
          >
            {t("login.signIn")}
          </button>
        </form>

        {error && (
          <p role="alert" className="text-status-error text-label text-center">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
