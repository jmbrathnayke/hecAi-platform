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

      <div className="mx-auto flex w-full max-w-md flex-col gap-design-5 px-design-5 py-design-6">
        <section className="flex flex-col gap-design-4 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
          <StaffAccountDetails account={account} />
          <StaffPasswordToggle account={account} />
        </section>

        {pending > 0 && (
          <div
            role="status"
            data-testid="pending-sync-warning"
            className="flex flex-col gap-design-3 rounded-md border border-status-warning bg-amber-pale p-design-4"
          >
            <p className="text-body text-ink-primary">{t("pendingSync", { count: pending })}</p>
            <Link
              href="/officer/sync"
              className="min-h-touch-target self-start rounded-md border border-forest px-design-4 py-design-2 text-label font-semibold text-forest"
            >
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
              className="min-h-primary-btn rounded-md bg-status-error px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-60"
            >
              {signingOut ? t("signingOut") : t("signOutAnyway")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-touch-target rounded-md border border-border-default px-design-4 text-label font-medium text-ink-secondary"
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={signingOut}
            onClick={handleSignOut}
            className="min-h-primary-btn rounded-md border-2 border-status-error px-design-4 text-label font-semibold text-status-error transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {signingOut ? t("signingOut") : t("signOut")}
          </button>
        )}
      </div>
    </main>
  );
}
