"use client";
// Citizen login via phone OTP (Story 4.0). Localized (app/[locale]) — unlike the English-only
// officer portal. Anonymous reporting stays available; this is the OPTIONAL account for "My Cases".
// Supabase sends the SMS OTP via its configured provider (Twilio); phone signups auto-create the
// user on first verify, so one flow covers both sign-in and sign-up.
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

  const [phase, setPhase] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Guards state updates after the async auth call resolves post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: sendError } = await getSupabase().auth.signInWithOtp({ phone });
      if (!mountedRef.current) return;
      if (sendError) {
        setError(t("sendError"));
        return;
      }
      setPhase("otp");
    } catch {
      if (mountedRef.current) setError(t("networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: verifyError } = await getSupabase().auth.verifyOtp({
        phone,
        token: code,
        type: "sms",
      });
      if (!mountedRef.current) return;
      if (verifyError) {
        setError(t("verifyError"));
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

        {phase === "phone" ? (
          <form onSubmit={handleSendCode} className="space-y-design-3">
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("phonePlaceholder")}
              aria-label={t("phone")}
              required
              className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t("sendCode")}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-design-3">
            <p role="status" className="text-caption text-ink-secondary text-center">
              {t("codeSent")}
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("codePlaceholder")}
              aria-label={t("code")}
              required
              className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body text-center tracking-widest"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t("verify")}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("phone");
                setCode("");
                setError(null);
              }}
              className="w-full text-caption text-forest underline"
            >
              {t("changeNumber")}
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="text-status-error text-label text-center">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
