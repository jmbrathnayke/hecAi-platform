"use client";

// System Administrator login (FR-11). Mirrors app/officer/login/page.tsx exactly, including
// its Suspense boundary, lazy Supabase client and unmount guard — the differences are the
// translation namespace and the post-sign-in destination.
//
// SEPARATE FROM /admin/login on purpose. A system administrator signing in there would land on
// /admin/cases, which require_admin() refuses them — they hold `system_admin`, not `admin`. Two
// roles that cannot use each other's surfaces need two entry points.
//
// Role is NOT enforced here. That is the backend's job (require_system_admin()) plus the users
// page's own "forbidden" state, matching the officer and DS precedent — this page only
// establishes a session. Enforcing it client-side would be advisory at best, since the token is
// what the API actually checks.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient, isAuthReachable } from "@/lib/supabase";
import { callbackErrorKey } from "@/lib/authErrors";

type SupabaseClient = ReturnType<typeof createClient>;

// useSearchParams() requires a Suspense boundary in the App Router or the build fails with a
// static-bailout error. The fallback is null: searchParams only contributes a post-redirect error
// banner, so there is nothing meaningful to render while suspended.
export default function SystemLoginPage() {
  return (
    <Suspense fallback={null}>
      <SystemLoginPageContent />
    </Suspense>
  );
}

function SystemLoginPageContent() {
  const t = useTranslations("system");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Lazy-init: createClient() must not run during SSR prerender, where env vars may be absent.
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
  // Guards state updates after the async sign-in resolves post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface a failed OAuth round-trip: app/auth/callback/route.ts bounces failures back with
  // ?error=<code>, and without this the officer sees a blank form and no explanation.
  useEffect(() => {
    const key = callbackErrorKey(searchParams.get("error"));
    if (key) setError(t(key));
  }, [searchParams, t]);

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      // Advisory preflight: signInWithOAuth() only builds a URL and redirects, so it can never
      // report an unreachable Auth host. It warns and continues rather than blocking, because a
      // cross-origin fetch cannot distinguish an outage from CORS or an ad-blocker.
      if (!(await isAuthReachable()) && mountedRef.current) {
        setError(t("login.networkError"));
      }
      const { error: signInError } = await getSupabase().auth.signInWithOAuth({
        provider: "google",
        // Must return to /auth/callback, not straight to the dashboard: the provider comes back
        // with a PKCE `?code=` that only a server-side exchangeCodeForSession() can turn into
        // session cookies.
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/system/users")}`,
          // ALWAYS show Google's account chooser. Without prompt=select_account, Google silently
          // reuses whichever account the browser is already signed into and never asks. On a
          // shared Divisional Secretariat desktop that means the second officer of the day is
          // signed in as the first, every audit_log row names the wrong person, and nothing on
          // screen reveals it — the failure is invisible precisely because it looks like success.
          // In a system whose contribution is a tamper-evident audit trail, that is the one
          // identity mistake that must not be possible.
          queryParams: { prompt: "select_account" },
        },
      });
      if (!mountedRef.current) return;
      if (signInError) {
        setError(signInError.message);
      }
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
      router.push("/system/users");
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

        <div className="flex items-center gap-design-3 text-label text-ink-disabled">
          <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
          <span>{t("login.or")}</span>
          <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
        </div>

        <form onSubmit={handleEmailSignIn} className="space-y-design-3">
          {/* Visible labels are sr-only: placeholders vanish on focus and are not reliably
              announced, so the accessible name has to exist independently. */}
          <label htmlFor="system-email" className="sr-only">
            {t("login.emailPlaceholder")}
          </label>
          <input
            id="system-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("login.emailPlaceholder")}
            required
            className="min-h-touch-target w-full rounded-md border border-border-default px-design-3 py-design-2 text-body"
          />
          <label htmlFor="system-password" className="sr-only">
            {t("login.passwordPlaceholder")}
          </label>
          <input
            id="system-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("login.passwordPlaceholder")}
            required
            className="min-h-touch-target w-full rounded-md border border-border-default px-design-3 py-design-2 text-body"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-primary-btn bg-amber text-ink-on-amber text-headline font-semibold rounded-md disabled:opacity-60"
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
