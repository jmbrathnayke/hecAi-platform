"use client";
// Citizen login / sign-up (Story 4.0). Localized (app/[locale]) — unlike the English-only officer
// portal. Anonymous reporting stays available; this is the OPTIONAL account for "My Cases".
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase";

type SupabaseClient = ReturnType<typeof createClient>;

export default function CitizenLoginPage() {
  const t = useTranslations("login");
  const locale = useLocale();
  const router = useRouter();

  // Lazy-init: createClient() must not run during SSR prerender (env vars may be absent in CI).
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const getSupabase = useCallback(() => {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  }, []);

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Guards state updates after the async auth call resolves post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { error: signUpError } = await getSupabase().auth.signUp({ email, password });
        if (!mountedRef.current) return;
        if (signUpError) {
          setError(t("signUpError"));
          return;
        }
        // Supabase requires email confirmation by default → no session yet; guide the user.
        setNotice(t("checkEmail"));
        return;
      }
      const { error: signInError } = await getSupabase().auth.signInWithPassword({
        email,
        password,
      });
      if (!mountedRef.current) return;
      if (signInError) {
        setError(t("signInError"));
        return;
      }
      router.push(`/${locale}/my-cases`);
    } catch {
      if (mountedRef.current) setError(t("networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-surface-base flex items-center justify-center px-design-4">
      <div className="w-full max-w-sm bg-surface-raised rounded-lg border border-border-default p-design-6 space-y-design-4">
        <div className="space-y-design-1 text-center">
          <h1 className="text-title text-ink-primary">{t("title")}</h1>
          <p className="text-caption text-ink-secondary">{t("subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-design-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("emailPlaceholder")}
            aria-label={t("email")}
            required
            className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("password")}
            aria-label={t("password")}
            required
            minLength={6}
            className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
          >
            {mode === "signup" ? t("signUp") : t("signIn")}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "signin" ? "signup" : "signin"));
            setError(null);
            setNotice(null);
          }}
          className="w-full text-caption text-forest underline"
        >
          {mode === "signin" ? t("toggleToSignUp") : t("toggleToSignIn")}
        </button>

        {error && (
          <p role="alert" className="text-status-error text-label text-center">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-forest text-label text-center">
            {notice}
          </p>
        )}
      </div>
    </main>
  );
}
