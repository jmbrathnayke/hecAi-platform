"use client";

// Staff account in the navbar: who is signed in, in which role and area, and sign-out. Used in the
// admin, Divisional Secretariat and system administration top bars; the officer field app shows
// the same details on its Profile tab instead (app/officer/profile).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { readStaffAccount, signOutStaff, type StaffAccount } from "@/lib/staffAccount";
import { StaffPasswordForm } from "@/components/StaffPasswordForm";

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
    <StaffPasswordForm onDone={() => setOpen(false)} />
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="min-h-touch-target w-full rounded-md border border-border-default px-design-3 text-label font-medium text-ink-primary hover:bg-surface-base"
    >
      {t("changePassword")}
    </button>
  );
}

export function StaffAccountMenu({ loginPath }: { loginPath: string }) {
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
        className="flex min-h-touch-target items-center gap-design-2 rounded-md px-design-2 text-label text-ink-on-dark transition-colors hover:bg-white/10"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-pill bg-white/15 text-[16px]"
        >
          👤
        </span>
        <span className="hidden max-w-[16rem] truncate sm:inline">{account?.email ?? t("account")}</span>
        <span aria-hidden="true" className="text-caption">
          ▾
        </span>
      </button>

      {open && (
        <div
          id="staff-account-panel"
          role="region"
          aria-label={t("account")}
          className="absolute right-0 top-full z-50 mt-design-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-lg"
        >
          <StaffAccountDetails account={account} />
          <div className="mt-design-4">
            <StaffPasswordToggle account={account} />
          </div>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
            className="mt-design-3 min-h-touch-target w-full rounded-md border-2 border-status-error px-design-3 text-label font-semibold text-status-error transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {signingOut ? t("signingOut") : t("signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
