"use client";
// The registration-check screens shared by the report entrance and the registration page: checking,
// sign in (state C) and "unable to verify" (state D). Not-registered and registered have their own,
// page-specific screens. See lib/registrationState.ts for why these are distinct.
import { useTranslations } from "next-intl";

interface Props {
  kind: "checking" | "unauthenticated" | "unavailable";
  onRetry?: () => void;
  onSignIn?: () => void;
}

export function RegistrationStateNotice({ kind, onRetry, onSignIn }: Props) {
  const t = useTranslations("registrationGate");

  if (kind === "checking") {
    return (
      <main
        className="mx-auto flex w-full max-w-md flex-col items-center gap-design-4 px-design-5 py-design-7"
        role="status"
        aria-live="polite"
        data-testid="registration-checking"
      >
        <span
          className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest"
          aria-hidden="true"
        />
        <p className="text-body text-ink-secondary">{t("checking")}</p>
      </main>
    );
  }

  const signIn = kind === "unauthenticated";
  return (
    <main
      className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6"
      data-testid={signIn ? "registration-sign-in" : "registration-unavailable"}
    >
      <header>
        <h1 className="text-title font-bold text-ink-primary">
          {t(signIn ? "signInTitle" : "unavailableTitle")}
        </h1>
      </header>
      {/* role="status": neither case is the citizen's fault, and "unavailable" in particular must
          never read as "you are not registered". */}
      <p role="status" className="text-body text-ink-primary">
        {t(signIn ? "signInBody" : "unavailableBody")}
      </p>
      <button
        type="button"
        onClick={signIn ? onSignIn : onRetry}
        className="min-h-touch-target rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
      >
        {t(signIn ? "signIn" : "retry")}
      </button>
    </main>
  );
}
