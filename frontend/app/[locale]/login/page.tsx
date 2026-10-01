"use client";
// Citizen sign-in (Story 4.0). Localized (app/[locale]) — unlike the English-only staff portals.
// Anonymous reporting stays available; this is the OPTIONAL account for "My Cases".
//
// TWO WAYS IN, AND WHY BOTH. Email + password is the everyday one. The one-time email link remains,
// and is what CREATES an account: opening it is what proves the address belongs to the person, so a
// password is only ever set on a verified address (the citizen sets it afterwards in their profile).
// The link is also the recovery path, so a forgotten password never locks a family out of a claim.
//
// There is no phone or SMS option: the platform does not send SMS for any purpose, and no phone
// number is needed to sign in or to receive notifications.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";

type SupabaseClient = ReturnType<typeof createClient>;

// CROSS-DEVICE CONFIRMATION. Supabase creates the session on whichever device OPENS the
// confirmation link, so a citizen who signs up on a phone and opens the email on a laptop is signed
// in on the laptop and left waiting on the phone. The "check your email" screen therefore keeps
// trying the email and password it already holds: the answer is "Email not confirmed" until the
// link is opened anywhere, and a session the moment it has been. Paced to stay well inside Supabase's
// sign-in limit (30 per 5 minutes per IP): a try after 5 s, every 10 s for two minutes, every 20 s
// after that, none after ten minutes, plus one at once whenever the citizen comes back to this tab.
// (Not exported: a Next.js page module may export only the page and its route config.)
const CONFIRM_POLL = {
  firstMs: 5_000,
  fastMs: 10_000,
  fastForMs: 120_000,
  slowMs: 20_000,
  giveUpMs: 600_000,
  /** Focus and visibility events can fire together; never two tries closer than this. */
  minGapMs: 4_000,
} as const;

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

  // "password" is the everyday way in; "signup" creates an account with a password the citizen
  // chooses; "link" is the recovery path, and the two "-sent" modes tell them to open their inbox
  // rather than wait on this screen.
  const [mode, setMode] = useState<"password" | "signup" | "link" | "link-sent" | "confirm-sent">(
    "password",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

  // Cross-device confirmation (CONFIRM_POLL). Held in refs so the waiting loop never restarts on a
  // re-render; the credentials are the ones just used to sign up, kept in memory only.
  const credentialsRef = useRef({ email: "", password: "" });
  const navRef = useRef({ router, locale });
  useEffect(() => {
    navRef.current = { router, locale };
  });
  const lastTryRef = useRef(0);
  const [confirmNote, setConfirmNote] = useState<"waiting" | "still-waiting" | "timed-out">("waiting");
  const [checking, setChecking] = useState(false);

  /** -> true once the address is confirmed and the citizen is signed in and on their way. */
  const tryConfirmedSignIn = useCallback(
    async (force: boolean): Promise<boolean> => {
      const now = Date.now();
      if (!force && now - lastTryRef.current < CONFIRM_POLL.minGapMs) return false;
      lastTryRef.current = now;
      try {
        const { error: signInError } = await getSupabase().auth.signInWithPassword(credentialsRef.current);
        // "Email not confirmed" is the expected answer while waiting, so it is never shown as an error.
        if (signInError || !mountedRef.current) return false;
        navRef.current.router.push(`/${navRef.current.locale}/my-cases`);
        return true;
      } catch {
        return false;
      }
    },
    [getSupabase],
  );

  useEffect(() => {
    if (mode !== "confirm-sent") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    setConfirmNote("waiting");

    const tick = async () => {
      if (stopped || (await tryConfirmedSignIn(false)) || stopped) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= CONFIRM_POLL.giveUpMs) {
        setConfirmNote("timed-out");
        return;
      }
      timer = setTimeout(tick, elapsed < CONFIRM_POLL.fastForMs ? CONFIRM_POLL.fastMs : CONFIRM_POLL.slowMs);
    };
    timer = setTimeout(tick, CONFIRM_POLL.firstMs);

    // Back on this tab after confirming in the mail app or on another device: try straight away.
    const onReturn = () => {
      if (document.visibilityState === "visible") void tryConfirmedSignIn(false);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [mode, tryConfirmedSignIn]);

  async function handleCheckNow() {
    if (checking) return;
    setChecking(true);
    const ok = await tryConfirmedSignIn(true);
    if (!mountedRef.current || ok) return;
    setChecking(false);
    setConfirmNote("still-waiting");
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: signInError } = await getSupabase().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (!mountedRef.current) return;
      if (signInError) {
        // Supabase does not say WHICH of the two was wrong, and neither should this screen: that
        // is what stops it being used to find out which addresses have accounts.
        setError(t("wrongCredentials"));
        return;
      }
      router.push(`/${locale}/my-cases`);
    } catch {
      if (mountedRef.current) setError(t("networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: signUpError } = await getSupabase().auth.signUp({
        email: email.trim(),
        password,
      });
      if (!mountedRef.current) return;
      if (signUpError) {
        const already = /already|registered|exists/i.test(signUpError.message ?? "");
        setError(already ? t("emailTaken") : t("signUpError"));
        return;
      }
      // Whether a session comes back depends on the project's "confirm email" setting: with it on,
      // the address must be confirmed first, so say so instead of dropping them on a signed-out app.
      if (data.session) {
        router.push(`/${locale}/my-cases`);
        return;
      }
      credentialsRef.current = { email: email.trim(), password };
      setMode("confirm-sent");
    } catch {
      if (mountedRef.current) setError(t("networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

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
      setMode("link-sent");
    } catch {
      if (mountedRef.current) setError(t("networkError"));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const FIELD =
    "w-full min-h-touch-target border border-border-default rounded-md px-design-3 py-design-2 text-body";

  return (
    <main className="min-h-screen bg-surface-base flex items-center justify-center px-design-4">
      <div className="w-full max-w-sm bg-surface-raised rounded-lg border border-border-default p-design-6 space-y-design-4">
        <div className="space-y-design-1 text-center">
          <h1 className="text-title text-ink-primary">{t("title")}</h1>
          <p className="text-caption text-ink-secondary">{t("subtitle")}</p>
        </div>

        {mode === "password" && (
          <form onSubmit={handlePasswordSignIn} className="space-y-design-3">
            <div className="space-y-design-1">
              <label htmlFor="login-email" className="text-label font-medium text-ink-primary">
                {t("email")}
              </label>
              <input
                id="login-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                required
                className={FIELD}
              />
            </div>
            <div className="space-y-design-1">
              <label htmlFor="login-password" className="text-label font-medium text-ink-primary">
                {t("password")}
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={FIELD}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {submitting ? t("signingIn") : t("signIn")}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode("signup");
                setError(null);
              }}
              className="w-full min-h-touch-target rounded-md border border-forest text-label font-semibold text-forest"
            >
              {t("createAccount")}
            </button>

            <p className="text-caption text-ink-secondary">{t("newHere")}</p>
            <button
              type="button"
              onClick={() => {
                setMode("link");
                setError(null);
              }}
              className="w-full min-h-touch-target text-label font-semibold text-forest"
            >
              {t("useLink")}
            </button>
          </form>
        )}

        {mode === "signup" && (
          <form onSubmit={handleSignUp} className="space-y-design-3">
            <p className="text-caption text-ink-secondary">{t("createAccountHint")}</p>
            <div className="space-y-design-1">
              <label htmlFor="signup-email" className="text-label font-medium text-ink-primary">
                {t("email")}
              </label>
              <input
                id="signup-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                required
                className={FIELD}
              />
            </div>
            <div className="space-y-design-1">
              <label htmlFor="signup-password" className="text-label font-medium text-ink-primary">
                {t("choosePassword")}
              </label>
              <input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={FIELD}
              />
            </div>
            <div className="space-y-design-1">
              <label htmlFor="signup-confirm" className="text-label font-medium text-ink-primary">
                {t("confirmPassword")}
              </label>
              <input
                id="signup-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className={FIELD}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {submitting ? t("signingUp") : t("signUp")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("password");
                setError(null);
              }}
              className="w-full min-h-touch-target text-label font-semibold text-forest"
            >
              {t("haveAccount")}
            </button>
          </form>
        )}

        {mode === "confirm-sent" && (
          <div className="space-y-design-3">
            <p role="status" className="text-body text-ink-primary text-center">
              {t("confirmSent")}
            </p>
            <p
              data-testid="confirm-note"
              aria-live="polite"
              className="text-caption text-ink-secondary text-center"
            >
              {confirmNote === "waiting"
                ? t("confirmWaiting")
                : confirmNote === "still-waiting"
                  ? t("confirmStillWaiting")
                  : t("confirmTimedOut")}
            </p>
            <button
              type="button"
              onClick={() => void handleCheckNow()}
              disabled={checking}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t("confirmCheckNow")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("password");
                setError(null);
              }}
              className="w-full min-h-touch-target text-label font-semibold text-forest"
            >
              {t("haveAccount")}
            </button>
          </div>
        )}

        {mode === "link" && (
          <form onSubmit={handleSendLink} className="space-y-design-3">
            <div className="space-y-design-1">
              <label htmlFor="link-email" className="text-label font-medium text-ink-primary">
                {t("email")}
              </label>
              <input
                id="link-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                required
                className={FIELD}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-touch-target bg-amber text-ink-on-amber text-label font-semibold rounded-md disabled:opacity-60"
            >
              {t("sendLink")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("password");
                setError(null);
              }}
              className="w-full min-h-touch-target text-label font-semibold text-forest"
            >
              {t("backToPassword")}
            </button>
          </form>
        )}

        {mode === "link-sent" && (
          <div className="space-y-design-3">
            <p role="status" className="text-body text-ink-primary text-center">
              {t("linkSent")}
            </p>
            <p className="text-caption text-ink-secondary text-center">{t("linkHint")}</p>
            <button
              type="button"
              onClick={() => {
                setMode("link");
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
