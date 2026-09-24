"use client";
// Step 1 of the incident form: the family the report is filed for.
//
// NO NIC OR PHONE NUMBER IS ASKED FOR HERE. Every citizen who reaches the form is signed in and
// registered (the gate below), and the server links the case to that household from the verified
// account (cases.py, FR-10.3) — district and DS division included (FR-10.6). The NIC and mobile this
// step used to collect were AES-GCM encrypted with a per-device key the server can never read, so
// re-typing them added effort and client-side PII without informing anything the server decides.
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { getCase, putCase } from "@/lib/indexeddb";
import { getOrCreateDraftId } from "@/lib/draft";
import { checkRegistration, type RegistrationState } from "@/lib/registrationState";
import { RegistrationStateNotice } from "@/components/RegistrationStateNotice";

type Registered = Extract<RegistrationState, { kind: "registered" }>;

export default function FamilyStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // FR-10.3 gate, visible half (Story 8.4). The backend refuses an unregistered submission
  // with 403 not_registered; without this check a citizen would fill in four steps and take
  // photographs at the damage site before being told they cannot file. Checked here, at the
  // entrance, so the cost of being unregistered is one screen instead of the whole form.
  //
  // Five outcomes, not two (lib/registrationState.ts). Until 2026-09 "no session" and "API
  // unreachable" were both shown as "register your family first", which told registered families
  // to register again whenever the signal dropped.
  const [gate, setGate] = useState<RegistrationState | { kind: "checking" }>({ kind: "checking" });
  const gateT = useTranslations("registrationGate");

  const runCheck = useCallback(async (isActive: () => boolean = () => true) => {
    setGate({ kind: "checking" });
    const state = await checkRegistration();
    if (isActive()) setGate(state);
  }, []);

  useEffect(() => {
    let active = true;
    void runCheck(() => active);
    return () => {
      active = false;
    };
  }, [runCheck]);

  async function handleNext(household: Registered) {
    if (saving) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const offlineId = getOrCreateDraftId();
      const existing = (await getCase(offlineId)) ?? {};

      // Save first, navigate second (CRITICAL #5 — avoid data loss on slow devices). The area is
      // kept on the draft only so the receipt can show it; the server takes it from the household.
      await putCase({
        ...existing,
        offline_id: offlineId,
        ...(household.district && household.dsDivision
          ? { district: household.district, ds_division: household.dsDivision }
          : {}),
        sync_status: "draft",
        updated_at: new Date().toISOString(),
        created_at: (existing as { created_at?: string }).created_at ?? new Date().toISOString(),
      });

      router.push("/report/location");
    } catch {
      // IndexedDB / storage failure — keep the user here.
      setSubmitError(t("step1.saveError"));
    } finally {
      setSaving(false);
    }
  }

  if (gate.kind === "checking") {
    return <RegistrationStateNotice kind="checking" />;
  }

  if (gate.kind === "unauthenticated" || gate.kind === "unavailable") {
    return (
      <RegistrationStateNotice
        kind={gate.kind}
        onRetry={() => void runCheck()}
        onSignIn={() => router.push("/login")}
      />
    );
  }

  if (gate.kind === "not-registered") {
    return (
      <main
        className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6"
        data-testid="registration-required"
      >
        <header>
          <h1 className="text-title font-bold text-ink-primary">{t("gate.title")}</h1>
        </header>
        {/* A step, not a refusal — the citizen has done nothing wrong and there is exactly
            one thing to do next. */}
        <p className="text-body text-ink-primary">{t("gate.body")}</p>
        <button
          type="button"
          onClick={() => router.push("/register")}
          className="min-h-touch-target rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
        >
          {t("gate.register")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
      <StepIndicator steps={steps} currentStep={0} />

      {gate.source === "cached" && (
        <p role="status" className="rounded-md bg-surface-tint px-design-4 py-design-3 text-caption text-ink-secondary">
          {gateT("offlineConfirmed", { ref: gate.householdRef })}
        </p>
      )}

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("step1.title")}</h1>
        <p className="mt-design-2 text-body text-ink-secondary">{t("step1.intro")}</p>
      </header>

      <dl
        data-testid="reporting-household"
        className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-raised px-design-4 shadow-card"
      >
        <div className="flex items-start justify-between gap-design-3 py-design-3">
          <dt className="text-caption text-ink-secondary">{t("step1.householdRef")}</dt>
          <dd className="font-mono text-label font-semibold text-ink-primary">{gate.householdRef}</dd>
        </div>
        {gate.district && gate.dsDivision && (
          <div className="flex items-start justify-between gap-design-3 py-design-3">
            <dt className="text-caption text-ink-secondary">{t("step1.area")}</dt>
            <dd className="text-right text-label font-semibold text-ink-primary">
              {gate.district} / {gate.dsDivision}
            </dd>
          </div>
        )}
      </dl>

      {submitError && (
        <p role="alert" className="text-caption text-status-error">
          {submitError}
        </p>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleNext(gate)}
        className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {t("step1.next")}
      </button>
    </main>
  );
}
