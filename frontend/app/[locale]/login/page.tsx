"use client";
// Citizen sign-in (Story 4.0). Localized (app/[locale]) — unlike the English-only staff portals.
// Anonymous reporting stays available; this is the OPTIONAL account for "My Cases".
//
// EMAIL ONLY. Supabase emails a one-time sign-in link; first use creates the account, so one flow
// covers both sign-in and sign-up. There is no phone or SMS option: the platform does not send SMS
// for any purpose, and no phone number is needed to sign in or to receive notifications.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase";

type SupabaseClient = ReturnType<typeof createClient>;

export default function CitizenLoginPage() {
  const t = useTranslations("login");

  // Lazy-init: createClient() must not run during SSR prerender (env vars may be absent in CI).
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const getSupabase = useCallback(() => {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  }, []);

  // Two phases. Supabase's default email template sends a magic LINK, not a code, so the second
  // phase tells the citizen to open their inbox rather than asking for something that never arrives.
  const [phase, setPhase] = useState<"identify" | "link-sent">("identify");
  const [email, setEmail] = useState("");
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

  async function handleSendLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: sendError } = await getSupabase().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true },
      });
      if (!mountedRef.current) return;
      if (sendError) {
        setError(t("sendError"));
        return;
      }
      setPhase("link-sent");
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
          <form onSubmit={handleSendLink} className="space-y-design-3">
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
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t("sendLink")}
            </button>
          </form>
        ) : (
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
