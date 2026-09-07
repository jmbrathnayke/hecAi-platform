"use client";
// Citizen login via phone OTP (Story 4.0). Localized (app/[locale]) — unlike the English-only
// officer portal. Anonymous reporting stays available; this is the OPTIONAL account for "My Cases".
// Supabase sends the SMS OTP via its configured provider (Twilio); phone signups auto-create the
// user on first verify, so one flow covers both sign-in and sign-up.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase";
import { toE164SriLanka } from "@/lib/validation";

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

  // Three phases, because the two channels genuinely differ. Supabase's default email template
  // sends a magic LINK, not a token, so asking for a six-digit code after an email would be
  // asking for something that never arrives. SMS does send a code. Verified 2026-09-01.
  const [phase, setPhase] = useState<"identify" | "otp" | "link-sent">("identify");
  // The E.164 form actually sent to Supabase. Kept in state because verifyOtp() must be given
  // the SAME string signInWithOtp() was given — verifying against the raw "0714790447" the user
  // typed would fail even after a code arrived.
  const [e164, setE164] = useState("");
  // Channel. Phone SMS requires an SMS provider configured on the Supabase project; email uses
  // Supabase's built-in sender and needs no external service. Verified 2026-09-01: this project
  // has phone OFF and email ON, so email is the default and phone is kept for when SMS is
  // provisioned.
  const [channel, setChannel] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState("");
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
      let sendError;
      if (channel === "email") {
        ({ error: sendError } = await getSupabase().auth.signInWithOtp({
          email: email.trim(),
          // A six-digit code, not a magic link: the code can be read on a phone and typed on the
          // laptop under test, which a link cannot.
          options: { shouldCreateUser: true },
        }));
      } else {
        // Supabase requires E.164. Converting here rather than asking the citizen to type
        // "+94..." — 07X XXX XXXX is how the number is written on every form in the country.
        const normalised = toE164SriLanka(phone);
        if (!normalised) {
          setError(t("invalidPhone"));
          return;
        }
        setE164(normalised);
        ({ error: sendError } = await getSupabase().auth.signInWithOtp({ phone: normalised }));
      }
      if (!mountedRef.current) return;
      if (sendError) {
        setError(t("sendError"));
        return;
      }
      // Email gets a link to click; SMS gets a code to type.
      setPhase(channel === "email" ? "link-sent" : "otp");
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
      // Verify against the SAME identifier the code was sent to.
      const { error: verifyError } = await getSupabase().auth.verifyOtp(
        channel === "email"
          ? { email: email.trim(), token: code, type: "email" }
          : { phone: e164, token: code, type: "sms" },
      );
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

        {phase === "identify" ? (
          <form onSubmit={handleSendCode} className="space-y-design-3">
            <div className="flex gap-design-2" role="group" aria-label={t("channelLabel")}>
              {(["email", "phone"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setChannel(c);
                    setError(null);
                  }}
                  aria-pressed={channel === c}
                  className={`flex-1 min-h-touch-target rounded-md border text-label font-semibold ${
                    channel === c
                      ? "border-forest bg-forest text-ink-on-dark"
                      : "border-border-default text-ink-primary"
                  }`}
                >
                  {t(c === "email" ? "useEmail" : "usePhone")}
                </button>
              ))}
            </div>

            {channel === "email" ? (
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                aria-label={t("email")}
                required
                className="w-full border border-border-default rounded-md px-design-3 py-design-2 text-body"
              />
            ) : (
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
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t(channel === "email" ? "sendLink" : "sendCode")}
            </button>
          </form>
        ) : phase === "link-sent" ? (
          <div className="space-y-design-3">
            <p role="status" className="text-body text-ink-primary text-center">
              {t("linkSent")}
            </p>
            <p className="text-caption text-ink-secondary text-center">{t("linkHint")}</p>
            <button
              type="button"
              onClick={() => {
                setPhase("identify");
                setError(null);
              }}
              className="w-full min-h-touch-target text-label font-semibold text-forest"
            >
              {t("changeEmail")}
            </button>
          </div>
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
                setPhase("identify");
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
