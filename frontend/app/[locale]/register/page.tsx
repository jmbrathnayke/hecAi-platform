"use client";
// Household registration entrance (Story 8.2 / 8.3, final governance workflow).
//
// A family registers ONCE. Before this gate the page opened straight onto the registration form,
// so a citizen who had already registered was walked through four steps only to be told so at
// the end. The check now runs first (lib/registrationState.ts):
//
//   not registered (A)            -> the registration form
//   already registered (B)        -> the household reference and "Report an incident"
//   not signed in (C)             -> sign in
//   check failed, nothing known (D) -> "Unable to verify registration right now. Please retry."
//   offline but confirmed before (E) -> treated as registered, from the confirmed local state
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import RegisterHouseholdForm from "@/components/RegisterHouseholdForm";
import { HouseholdConflictScreen } from "@/components/HouseholdConflictScreen";
import { RegistrationStateNotice } from "@/components/RegistrationStateNotice";
import {
  checkRegistration,
  rememberRegistrationForCurrentAccount,
  type RegistrationState,
} from "@/lib/registrationState";

export default function RegisterHouseholdPage() {
  const t = useTranslations("register");
  const router = useRouter();
  const [state, setState] = useState<RegistrationState | { kind: "checking" }>({ kind: "checking" });

  const runCheck = useCallback(async (isActive: () => boolean = () => true) => {
    setState({ kind: "checking" });
    const next = await checkRegistration();
    if (isActive()) setState(next);
  }, []);

  useEffect(() => {
    let active = true;
    void runCheck(() => active);
    return () => {
      active = false;
    };
  }, [runCheck]);

  if (state.kind === "checking") return <RegistrationStateNotice kind="checking" />;

  if (state.kind === "unauthenticated" || state.kind === "unavailable") {
    return (
      <RegistrationStateNotice
        kind={state.kind}
        onRetry={() => void runCheck()}
        onSignIn={() => router.push("/login")}
      />
    );
  }

  if (state.kind === "registered") {
    // The Story 8.3 own-account screen: the reference, why a family registers once, and
    // "Report an incident" as the primary action.
    return (
      <HouseholdConflictScreen variant="own-account" householdRef={state.householdRef} t={t} />
    );
  }

  return (
    <RegisterHouseholdForm
      onRegistered={(ref) => void rememberRegistrationForCurrentAccount(ref)}
    />
  );
}
