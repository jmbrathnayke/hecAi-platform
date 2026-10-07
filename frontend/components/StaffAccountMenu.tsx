"use client";

// Staff account in the navbar: who is signed in, in which role and area, and sign-out. Used in the
// admin, Divisional Secretariat and system administration top bars; the officer field app shows
// the same details on its Profile tab instead (app/officer/profile).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CaretDown, SignOut } from "@phosphor-icons/react";
import { readStaffAccount, signOutStaff, type StaffAccount } from "@/lib/staffAccount";
import { PasswordForm } from "@/components/PasswordForm";
import PushNotificationToggle from "@/components/PushNotificationToggle";

export function StaffAccountDetails({ account }: { account: StaffAccount | null }) {
  const t = useTranslations("staffAccount");
  const role = account?.role ?? null;
  const scopeValue =
    role === "system_admin"
      ? t("allAreas")
      : account && account.scope.length > 0
        ? account.scope.join(", ")
        : t("notAssigned");

  return (
    <dl data-testid="staff-account-details" className="flex flex-col gap-design-3">
      <div>
        <dt className="text-caption text-ink-secondary">{t("signedInAs")}</dt>
        <dd className="break-all text-label font-semibold text-ink-primary">{account?.email ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-caption text-ink-secondary">{t("role")}</dt>
        <dd className="text-label text-ink-primary">{role ? t(`roles.${role}`) : "—"}</dd>
      </div>
      {role && (
        <div>
          <dt className="text-caption text-ink-secondary">{t(`scope.${role}`)}</dt>
          <dd className="text-label text-ink-primary">{scopeValue}</dd>
        </div>
      )}
      {role && <p className="text-caption text-ink-secondary">{t("assignedByAdmin")}</p>}
    </dl>
  );
}

/** "Change password" for password accounts, expanding in place into the form. */
export function StaffPasswordToggle({ account }: { account: StaffAccount | null }) {
  const t = useTranslations("staffAccount");
  const [open, setOpen] = useState(false);
  if (!account?.canChangePassword) return null;
  return open ? (
    <PasswordForm onDone={() => setOpen(false)} />
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="min-h-[40px] w-full rounded-sm border border-border-subtle px-design-3 text-label font-medium text-ink-primary transition-colors duration-150 hover:bg-surface-base motion-reduce:transition-none"
    >
      {t("changePassword")}
    </button>
  );
}

/** Up to two letters from the part of the email before the @: "e2e-admin" -> "EA". */
function initials(email: string | null | undefined): string {
  const local = (email ?? "").split("@")[0];
  const parts = local.split(/[^a-zA-Z]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : local.slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function StaffAccountMenu({
  loginPath,
  showPushToggle = false,
}: {
  loginPath: string;
  /** Puts this device's notification switch in the menu. The admin portal moved it here from the
   *  case list, where a full-width card pushed the cases below the fold (2026-10-07). */
  showPushToggle?: boolean;
}) {
  const t = useTranslations("staffAccount");
  const router = useRouter();
  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void readStaffAccount().then((a) => {
      if (active) setAccount(a);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOutStaff();
    router.replace(loginPath);
  }

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="staff-account-panel"
        aria-label={t("account")}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[40px] items-center gap-design-2 rounded-sm px-design-1 text-label text-ink-primary transition-colors duration-150 hover:bg-surface-tint motion-reduce:transition-none sm:px-design-2"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-pill bg-forest-pale text-caption font-semibold text-forest"
        >
          {initials(account?.email)}
        </span>
        <span className="hidden max-w-[14rem] truncate font-medium md:inline">{account?.email ?? t("account")}</span>
        <CaretDown aria-hidden="true" size={14} className="text-ink-secondary" />
      </button>

      {open && (
        <div
          id="staff-account-panel"
          role="region"
          aria-label={t("account")}
          className="absolute right-0 top-full z-50 mt-design-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-overlay"
        >
          <StaffAccountDetails account={account} />
          {showPushToggle && (
            <div className="mt-design-4 border-t border-border-subtle pt-design-4">
              <PushNotificationToggle variant="staff" layout="row" />
            </div>
          )}
          <div className="mt-design-4 border-t border-border-subtle pt-design-4">
            <StaffPasswordToggle account={account} />
          </div>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
            className="mt-design-2 flex min-h-[40px] w-full items-center justify-center gap-design-2 rounded-sm px-design-3 text-label font-semibold text-status-error transition-colors duration-150 hover:bg-status-error-pale disabled:opacity-60 motion-reduce:transition-none"
          >
            <SignOut aria-hidden="true" size={16} />
            {signingOut ? t("signingOut") : t("signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
