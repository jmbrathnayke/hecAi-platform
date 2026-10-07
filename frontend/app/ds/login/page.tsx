"use client";

// Divisional Secretariat login (Story 8.5). Mirrors app/officer/login/page.tsx exactly, including
// its Suspense boundary, lazy Supabase client and unmount guard — the differences are the
// translation namespace and the post-sign-in destination.
//
// WHY THIS EXISTS. Story 8.5 shipped app/ds/dashboard and app/ds/layout.tsx but no login page and
// no middleware exemption, so /ds/* 307'd into the locale tree and 404'd. With the middleware
// fixed, an unauthenticated request now redirects here; without this page that redirect would
// itself 404 and the DS officer would still have no way in.
//
// Role is NOT enforced here. That is the backend's job (require_ds_officer()) plus the dashboard's
// own "forbidden" state, matching the officer precedent — this page only establishes a session.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient, isAuthReachable } from "@/lib/supabase";
import { callbackErrorKey } from "@/lib/authErrors";
import { GoogleLogo } from "@phosphor-icons/react";
import { StaffBrandMark } from "@/components/StaffBrandMark";
import { buttonStyles, fieldStyles } from "@/components/admin/ui";

type SupabaseClient = ReturnType<typeof createClient>;

// useSearchParams() requires a Suspense boundary in the App Router or the build fails with a
// static-bailout error. The fallback is null: searchParams only contributes a post-redirect error
// banner, so there is nothing meaningful to render while suspended.
export default function DsLoginPage() {
  return (
    <Suspense fallback={null}>
      <DsLoginPageContent />
    </Suspense>
  );
}

function DsLoginPageContent() {
  const t = useTranslations("ds");
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
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/ds/dashboard")}`,
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
      router.push("/ds/dashboard");
    } catch {
      if (mountedRef.current) setError(t("login.networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  // Redesign (2026-10-07), the admin portal's sign-in: one primary action (Sign in, forest),
  // Google as the quieter alternative, labels above the inputs.
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-base px-design-4 py-design-7">
      <div className="w-full max-w-[400px]">
        <div className="mb-design-5">
          <StaffBrandMark label="HEC" size="lg" />
        </div>
        <div className="space-y-design-5 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-raised sm:p-design-6">
          <div>
            <h1 className="text-display tracking-tight text-ink-primary [text-wrap:balance]">{t("login.title")}</h1>
            <p className="mt-design-1 text-label text-ink-secondary">{t("login.subtitle")}</p>
          </div>

          <form onSubmit={handleEmailSignIn} className="space-y-design-4">
            <div className="flex flex-col gap-design-1">
              <label htmlFor="ds-email" className="text-caption font-medium text-ink-secondary">
                {t("login.emailLabel")}
              </label>
              <input
                id="ds-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("login.emailPlaceholder")}
                required
                className={`${fieldStyles} min-h-[44px] placeholder:text-ink-secondary`}
              />
            </div>
            <div className="flex flex-col gap-design-1">
              <label htmlFor="ds-password" className="text-caption font-medium text-ink-secondary">
                {t("login.passwordLabel")}
              </label>
              <input
                id="ds-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("login.passwordPlaceholder")}
                required
                className={`${fieldStyles} min-h-[44px] placeholder:text-ink-secondary`}
              />
            </div>
            <button type="submit" disabled={submitting} className={`${buttonStyles.primary} min-h-[44px] w-full`}>
              {t("login.signIn")}
            </button>
          </form>

          <div className="flex items-center gap-design-3 text-caption text-ink-secondary">
            <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
            {t("login.or")}
            <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={submitting}
            className={`${buttonStyles.secondary} min-h-[44px] w-full`}
          >
            <GoogleLogo aria-hidden="true" size={18} weight="bold" />
            {t("login.google")}
          </button>

          {error && (
            <p role="alert" className="rounded-sm bg-status-error-pale px-design-3 py-design-2 text-label text-status-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
