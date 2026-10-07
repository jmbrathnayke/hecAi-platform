"use client";

// Officer login (Story 3.1). Localized si/ta/en (Story 6.2, FR-9.1) via the officer i18n
// provider (Story 6.1) — lives outside app/[locale] so its URL stays unprefixed. Supabase
// auth error messages are passed through verbatim (they are provider-owned, not app copy).

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient, isAuthReachable } from "@/lib/supabase";
import { callbackErrorKey } from "@/lib/authErrors";
import { touchButtonStyles, touchFieldStyles } from "@/components/admin/ui";
import { GoogleLogo } from "@phosphor-icons/react";
import { StaffBrandMark } from "@/components/StaffBrandMark";

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
          // Always show Google's account chooser — see app/ds/login for the full reasoning.
          // Field officers share devices more than any other role here, so a silent reuse of the
          // previous officer's session would misattribute submissions and AI overrides alike.
          queryParams: { prompt: "select_account" },
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
    // Redesign (2026-10-07), the staff portals' sign-in at field-app sizes: email and password
    // first with labels above them, Sign in as the one primary action, Google as the alternative.
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
            <label htmlFor="officer-email" className="text-caption font-medium text-ink-secondary">
              {t("login.emailLabel")}
            </label>
            <input
              id="officer-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("login.emailPlaceholder")}
              required
              className={touchFieldStyles}
            />
          </div>
          <div className="flex flex-col gap-design-1">
            <label htmlFor="officer-password" className="text-caption font-medium text-ink-secondary">
              {t("login.passwordLabel")}
            </label>
            <input
              id="officer-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("login.passwordPlaceholder")}
              required
              className={touchFieldStyles}
            />
          </div>
          <button type="submit" disabled={submitting} className={touchButtonStyles.primary}>
            {t("login.signIn")}
          </button>
        </form>

        <div className="flex items-center gap-design-3 text-caption text-ink-secondary">
          <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
          <span>{t("login.or")}</span>
          <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={submitting}
          className={`${touchButtonStyles.secondary} w-full`}
        >
          <GoogleLogo aria-hidden="true" size={18} weight="bold" />
          {t("login.google")}
        </button>

        {error && (
          <p role="alert" className="text-status-error text-label text-center">
            {error}
          </p>
        )}
        </div>
      </div>
    </main>
  );
}
