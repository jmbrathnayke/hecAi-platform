"use client";

// Admin login (Story 5.1). Localized si/ta/en via the non-routed admin i18n provider (Story 6.3,
// FR-9.3 revised) — lives outside app/[locale] so it never gets a /si|/ta|/en prefix, mirroring the
// officer login tree; locale comes from the NEXT_LOCALE cookie the admin layout resolves. Unlike
// officer login, the email/password path additionally verifies role === "admin" from the returned
// user's app_metadata and signs a non-admin straight back out (CRITICAL #4: separate pages + a
// role check prevent role confusion). Supabase-returned auth errors are shown verbatim (provider
// copy, not ours to translate); only our own error strings are localized.

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
export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <AdminLoginPageContent />
    </Suspense>
  );
}

function AdminLoginPageContent() {
  const router = useRouter();
  const t = useTranslations("admin");
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
  // Guards state updates after the async sign-in resolves post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface a failed OAuth round-trip. app/auth/callback/route.ts bounces failures back here with
  // ?error=<code>; without this the admin sees a blank login form and no explanation at all.
  useEffect(() => {
    const key = callbackErrorKey(searchParams.get("error"));
    if (key) setError(t(key));
  }, [searchParams, t]);

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      // Advisory preflight, matching officer login (code review 2026-08-13). This page previously
      // had no preflight at all, so the failure mode the officer page documents — being handed to
      // the browser's own "site can't be reached" page having seen nothing from the app — was
      // still fully live for every administrator. It warns and continues rather than blocking:
      // a cross-origin fetch cannot tell a genuine outage from a CORS rejection or an ad-blocker.
      if (!(await isAuthReachable()) && mountedRef.current) {
        setError(t("login.networkError"));
      }
      const { error: signInError } = await getSupabase().auth.signInWithOAuth({
        provider: "google",
        // Role verification for the OAuth path happens downstream (the /admin/cases page via
        // useAdminSession / backend require_admin()) — the redirect flow doesn't return the user
        // synchronously the way signInWithPassword does, so we can't check the role here.
        //
        // Must return to /auth/callback, NOT straight to /admin/cases: the provider comes back
        // with a PKCE `?code=` that only a server-side exchangeCodeForSession() can turn into
        // session cookies. `next` still carries the admin to /admin/cases, so the downstream
        // role check above is unchanged.
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/admin/cases")}`,
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
      const { data, error: signInError } = await getSupabase().auth.signInWithPassword({
        email,
        password,
      });
      if (!mountedRef.current) return;
      if (signInError) {
        setError(signInError.message);
        return;
      }
      // Verify the authenticated user is actually an admin. A valid officer/citizen credential
      // must not land on the admin portal — sign them back out and refuse. (Backend
      // require_admin() is the real boundary; this is the client-side companion check.)
      if (data.user?.app_metadata?.role !== "admin") {
        try {
          await getSupabase().auth.signOut();
        } catch {
          // Even if sign-out fails, we still refuse entry below.
        }
        if (mountedRef.current) setError(t("login.accessDenied"));
        return;
      }
      router.push("/admin/cases");
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
