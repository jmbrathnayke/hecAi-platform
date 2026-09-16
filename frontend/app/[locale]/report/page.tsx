"use client";
// Step 1 of the incident form: citizen identity (NIC + mobile).
// NIC and mobile are AES-GCM encrypted (NFR-3.1) BEFORE any IndexedDB write.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { isValidNIC, isValidMobile } from "@/lib/validation";
import { getOrCreateSessionKey, encryptField } from "@/lib/crypto";
import { getCase, putCase } from "@/lib/indexeddb";
import { getOrCreateDraftId } from "@/lib/draft";
import { getMyHousehold } from "@/lib/households";

export default function IdentityStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const [nic, setNic] = useState("");
  const [mobile, setMobile] = useState("");
  const [nicError, setNicError] = useState<string | null>(null);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // FR-10.3 gate, visible half (Story 8.4). The backend refuses an unregistered submission
  // with 403 not_registered; without this check a citizen would fill in four steps and take
  // photographs at the damage site before being told they cannot file. Checked here, at the
  // entrance, so the cost of being unregistered is one screen instead of the whole form.
  const [gate, setGate] = useState<"checking" | "registered" | "unregistered">("checking");

  useEffect(() => {
    let active = true;
    void (async () => {
      const household = await getMyHousehold();
      // getMyHousehold() returns null for 404, for no session, and for an unreachable API.
      // All three land on the same screen deliberately: each ends with the citizen needing
      // to register or sign in, and none lets the form usefully proceed.
      if (active) setGate(household ? "registered" : "unregistered");
    })();
    return () => {
      active = false;
    };
  }, []);

  function validate(): boolean {
    const nicErr = isValidNIC(nic) ? null : t("step1.nicError");
    const mobileErr = isValidMobile(mobile) ? null : t("step1.mobileError");
    setNicError(nicErr);
    setMobileError(mobileErr);
    return !nicErr && !mobileErr;
  }

  async function handleNext() {
    if (!validate() || saving) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const key = await getOrCreateSessionKey();
      const nicEnc = await encryptField(nic.trim(), key);
      const mobileEnc = await encryptField(mobile.trim(), key);

      const offlineId = getOrCreateDraftId();
      const existing = (await getCase(offlineId)) ?? {};

      // Save first, navigate second (CRITICAL #5 — avoid data loss on slow devices).
      await putCase({
        ...existing,
        offline_id: offlineId,
        reporter_nic_ciphertext: nicEnc.ciphertext,
        reporter_nic_iv: nicEnc.iv,
        reporter_mobile_ciphertext: mobileEnc.ciphertext,
        reporter_mobile_iv: mobileEnc.iv,
        sync_status: "draft",
        updated_at: new Date().toISOString(),
        created_at: (existing as { created_at?: string }).created_at ?? new Date().toISOString(),
      });

      router.push("/report/location");
    } catch {
      // Crypto / IndexedDB / storage failure — keep the user here with their input.
      setSubmitError(t("step1.saveError"));
    } finally {
      setSaving(false);
    }
  }

  if (gate === "checking") {
    return (
      <main
        className="mx-auto flex w-full max-w-md flex-col items-center gap-design-4 px-design-5 py-design-7"
        role="status"
        aria-live="polite"
      >
        <span
          className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest"
          aria-hidden="true"
        />
        <p className="text-body text-ink-secondary">{t("gate.checking")}</p>
      </main>
    );
  }

  if (gate === "unregistered") {
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

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("step1.title")}</h1>
      </header>

      <form
        className="flex flex-col gap-design-5"
        onSubmit={(e) => {
          e.preventDefault();
          void handleNext();
        }}
      >
        <div className="flex flex-col gap-design-2">
          <label htmlFor="nic" className="text-label font-medium text-ink-primary">
            {t("step1.nic")}
          </label>
          <input
            id="nic"
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="000000000V or 200012345678"
            value={nic}
            onChange={(e) => setNic(e.target.value)}
            onBlur={() => setNicError(isValidNIC(nic) ? null : t("step1.nicError"))}
            aria-invalid={!!nicError}
            aria-describedby={nicError ? "nic-error" : undefined}
            className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none"
          />
          {nicError && (
            <p id="nic-error" role="alert" className="text-caption text-status-error">
              {nicError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-design-2">
          <label htmlFor="mobile" className="text-label font-medium text-ink-primary">
            {t("step1.mobile")}
          </label>
          <input
            id="mobile"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            placeholder="07XXXXXXXX"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            onBlur={() => setMobileError(isValidMobile(mobile) ? null : t("step1.mobileError"))}
            aria-invalid={!!mobileError}
            aria-describedby={mobileError ? "mobile-error" : undefined}
            className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none"
          />
          {mobileError && (
            <p id="mobile-error" role="alert" className="text-caption text-status-error">
              {mobileError}
            </p>
          )}
        </div>

        {submitError && (
          <p role="alert" className="text-caption text-status-error">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {t("step1.next")}
        </button>
      </form>
    </main>
  );
}
