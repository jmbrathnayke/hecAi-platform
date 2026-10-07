"use client";
// Officer profile: the signed-in account, its role and assigned divisions, and sign-out. Session
// presence is enforced by middleware like every /officer route; the details are display-only.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { OfficerTopBar } from "@/components/OfficerTopBar";
import { StaffAccountDetails, StaffPasswordToggle } from "@/components/StaffAccountMenu";
import { readStaffAccount, signOutStaff, type StaffAccount } from "@/lib/staffAccount";
import { getQueuedItems } from "@/lib/syncQueue";
import PushNotificationToggle from "@/components/PushNotificationToggle";
import { SignOut, Warning } from "@phosphor-icons/react";
import { touchButtonStyles } from "@/components/admin/ui";

export default function OfficerProfilePage() {
  const t = useTranslations("staffAccount");
  const router = useRouter();
  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [pending, setPending] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    void readStaffAccount().then((a) => {
      if (active) setAccount(a);
    });
    getQueuedItems()
      .then((items) => {
        if (active) setPending(items.length);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOutStaff();
    router.replace("/officer/login");
  }

  function handleSignOut() {
    // A queued report syncs under whichever session exists when it is sent — the server takes the
    // officer from the JWT — so signing out with reports still queued is confirmed, not silent.
    if (pending > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    void signOut();
  }

  return (
    <main className="flex flex-1 flex-col bg-surface-base">
      <OfficerTopBar label={t("profileTitle")} />

      <div className="mx-auto flex w-full max-w-md flex-col gap-design-4 px-design-4 py-design-5">
        <section className="flex flex-col gap-design-4 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
          <StaffAccountDetails account={account} />
          <StaffPasswordToggle account={account} />
        </section>

        {/* FR-6.4: alerts for the divisions this officer is assigned to. Moved here from the top of
            the case list (redesign, 2026-10-07): it is a setting for this phone, set once. */}
        <section className="rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
          <PushNotificationToggle variant="staff" layout="row" />
        </section>

        {pending > 0 && (
          <div
            role="status"
            data-testid="pending-sync-warning"
            className="flex flex-col gap-design-3 rounded-md border border-status-warning/40 bg-amber-pale p-design-4"
          >
            <p className="flex items-start gap-design-2 text-body text-ink-primary">
              <Warning aria-hidden="true" size={20} weight="fill" className="mt-0.5 shrink-0 text-status-warning" />
              {t("pendingSync", { count: pending })}
            </p>
            <Link href="/officer/sync" className={`${touchButtonStyles.secondary} self-start`}>
              {t("goToSync")}
            </Link>
          </div>
        )}

        {confirming ? (
          <div className="flex flex-col gap-design-2">
            <button
              type="button"
              disabled={signingOut}
              onClick={() => void signOut()}
              className="inline-flex min-h-primary-btn items-center justify-center gap-design-2 rounded-sm bg-status-error px-design-4 text-label font-semibold text-ink-on-dark transition-transform duration-150 active:scale-[0.98] disabled:opacity-60 motion-reduce:transition-none"
            >
              {signingOut ? t("signingOut") : t("signOutAnyway")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={touchButtonStyles.secondary}
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={signingOut}
            onClick={handleSignOut}
            className="inline-flex min-h-primary-btn items-center justify-center gap-design-2 rounded-sm border border-status-error bg-surface-raised px-design-4 text-label font-semibold text-status-error transition-[background-color,transform] duration-150 hover:bg-status-error-pale active:scale-[0.98] disabled:opacity-60 motion-reduce:transition-none"
          >
            <SignOut aria-hidden="true" size={18} />
            {signingOut ? t("signingOut") : t("signOut")}
          </button>
        )}
      </div>
    </main>
  );
}
