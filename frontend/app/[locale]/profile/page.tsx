"use client";
// Citizen profile: who is signed in, the family they registered, and sign-out. Session-protected by
// middleware like /my-cases. Shows only the caller's own household (GET /households/me) — never a
// NIC (the server holds only keyed digests) and only the last four digits of the bank account.
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { createClient } from "@/lib/supabase";
import { fetchMyHousehold, type MyHouseholdResult } from "@/lib/households";
import { signOutCitizen } from "@/lib/citizenSession";
import { HouseholdDetailsForm } from "@/components/HouseholdDetailsForm";
import { PasswordForm } from "@/components/PasswordForm";
import { CitizenGuide } from "@/components/CitizenGuide";
import { formatMobile } from "@/lib/validation";

type LoadState = { kind: "loading" } | MyHouseholdResult;

export default function ProfilePage() {
  const t = useTranslations("profile");
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const load = useCallback(async (isActive: () => boolean = () => true) => {
    setState({ kind: "loading" });
    const result = await fetchMyHousehold();
    if (isActive()) setState(result);
  }, []);

  useEffect(() => {
    let active = true;
    void load(() => active);
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (active) setEmail(data.session?.user.email ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    // Middleware admits only a live session, so this is a session that expired while open.
    if (state.kind === "unauthenticated") router.replace("/login");
  }, [state.kind, router]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOutCitizen();
    router.push("/");
  }

  return (
    <main className="flex-1 bg-surface-base pb-design-8">
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-design-3 px-design-5 py-design-4">
          <span aria-hidden="true" className="text-title">
            👤
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-headline text-ink-primary">{t("title")}</h1>
            {email && (
              <p className="truncate text-caption text-ink-secondary">
                {t("signedInAs")} <span className="font-medium text-ink-primary">{email}</span>
              </p>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-design-5 px-design-5 py-design-6">
        {state.kind === "loading" && (
          <p role="status" className="text-body text-ink-secondary">
            …
          </p>
        )}

        {state.kind === "error" && (
          <div
            role="alert"
            className="flex flex-col gap-design-3 rounded-md border border-status-error bg-status-error-pale p-design-4"
          >
            <p className="text-body text-status-error">{t("loadError")}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="min-h-touch-target self-start rounded-md border border-border-default bg-surface-raised px-design-4 text-label font-medium text-ink-primary"
            >
              {t("retry")}
            </button>
          </div>
        )}

        {state.kind === "not-registered" && (
          <section
            data-testid="profile-not-registered"
            className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card"
          >
            <h2 className="text-headline text-ink-primary">{t("notRegisteredTitle")}</h2>
            <p className="text-body text-ink-secondary">{t("notRegisteredBody")}</p>
            <button
              type="button"
              onClick={() => router.push("/register")}
              className="min-h-touch-target rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber"
            >
              {t("register")}
            </button>
          </section>
        )}

        {state.kind === "ok" && (
          <section
            data-testid="profile-household"
            aria-labelledby="profile-household-title"
            className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card"
          >
            <div className="flex items-center justify-between gap-design-3">
              <h2 id="profile-household-title" className="text-headline text-ink-primary">
                {t("householdTitle")}
              </h2>
              {!editing && (
                <button
                  type="button"
                  onClick={() => {
                    setSaved(false);
                    setEditing(true);
                  }}
                  className="min-h-touch-target shrink-0 rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
                >
                  {t("edit")}
                </button>
              )}
            </div>

            {saved && !editing && (
              <p role="status" className="rounded-md bg-forest-pale px-design-3 py-design-2 text-caption text-forest">
                {t("saved")}
              </p>
            )}

            {editing ? (
              <HouseholdDetailsForm
                household={state.household}
                onSaved={(household) => {
                  setState({ kind: "ok", household });
                  setEditing(false);
                  setSaved(true);
                }}
                onCancel={() => setEditing(false)}
                onSessionEnded={() => router.replace("/login")}
              />
            ) : (
              <dl className="flex flex-col divide-y divide-border-subtle">
                <Row label={t("householdRef")} value={state.household.household_ref} mono />
                <Row
                  label={t("area")}
                  value={`${state.household.district} / ${state.household.ds_division}`}
                />
                <Row label={t("gnDivision")} value={state.household.gn_division ?? t("notRecorded")} />
                <Row label={t("address")} value={state.household.address ?? t("notRecorded")} />
                <Row
                  label={t("contactEmail")}
                  value={state.household.contact_email ?? t("notRecorded")}
                />
                <Row
                  label={t("contactMobile")}
                  value={
                    state.household.contact_mobile
                      ? formatMobile(state.household.contact_mobile)
                      : t("notRecorded")
                  }
                />
                <Row
                  label={t("bankAccount")}
                  value={
                    state.household.bank_account_last4
                      ? t("bankAccountValue", { last4: state.household.bank_account_last4 })
                      : t("notRecorded")
                  }
                />
              </dl>
            )}

            <h3 className="mt-design-2 text-label font-semibold text-ink-primary">{t("members")}</h3>
            <ul className="flex flex-col gap-design-2">
              {state.household.members.map((m, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-design-3 rounded-md bg-surface-base px-design-3 py-design-2"
                >
                  <span className="text-body text-ink-primary">
                    {m.full_name ?? t("notRecorded")}
                    {m.relationship && !m.is_registrant && (
                      <span className="text-caption text-ink-secondary"> · {m.relationship}</span>
                    )}
                  </span>
                  {m.is_registrant && (
                    <span className="shrink-0 rounded-pill bg-forest-pale px-design-2 text-caption font-medium text-forest">
                      {t("memberRegistrant")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.kind !== "loading" && <CitizenGuide defaultOpen={state.kind === "not-registered"} />}

        {/* The account is created by a one-time email link; a password is what makes the next
            sign-in immediate, and is set here on an address the link already verified. */}
        <section className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
          <h2 className="text-headline text-ink-primary">{t("passwordTitle")}</h2>
          {changingPassword ? (
            <PasswordForm onDone={() => setChangingPassword(false)} />
          ) : (
            <>
              <p className="text-caption text-ink-secondary">{t("passwordHint")}</p>
              <button
                type="button"
                onClick={() => setChangingPassword(true)}
                className="min-h-touch-target self-start rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
              >
                {t("setPassword")}
              </button>
            </>
          )}
        </section>

        <button
          type="button"
          disabled={signingOut}
          onClick={() => void handleSignOut()}
          className="min-h-primary-btn rounded-md border-2 border-status-error px-design-4 text-label font-semibold text-status-error transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {signingOut ? t("signingOut") : t("signOut")}
        </button>
      </div>
    </main>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-design-3 py-design-3">
      <dt className="shrink-0 text-caption text-ink-secondary">{label}</dt>
      <dd
        className={`max-w-[65%] break-words text-right text-label font-semibold text-ink-primary ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
