"use client";

// Top bar for the Divisional Secretariat and System Administration trees, matching the admin
// shell's light bar (redesigned 2026-10-07: was a forest bar with an emoji mark). Neither tree had any chrome, so there was nowhere to show who was signed in
// and no way to sign out. Hidden on each tree's login page, which is a focused auth flow.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { StaffAccountMenu } from "@/components/StaffAccountMenu";
import { StaffBrandMark } from "@/components/StaffBrandMark";
import NotificationBell from "@/components/NotificationBell";

const TREES = {
  ds: { home: "/ds/dashboard", login: "/ds/login" },
  system: { home: "/system/users", login: "/system/login" },
} as const;

export function StaffTopBar({ tree }: { tree: keyof typeof TREES }) {
  const t = useTranslations("staffAccount");
  const pathname = usePathname();
  const { home, login } = TREES[tree];

  if (!pathname || pathname === login || pathname.startsWith(`${login}/`)) return null;

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-design-3 border-b border-border-subtle bg-surface-raised px-design-3 sm:px-design-4">
      <Link
        href={home}
        className="flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest"
      >
        <StaffBrandMark label={t(`brand.${tree}`)} compact />
      </Link>
      {/* The bell and the account menu travel together on the right. StaffAccountMenu keeps its
          own ml-auto, which is a no-op inside this group. */}
      <div className="ml-auto flex items-center gap-design-1 sm:gap-design-2">
        <NotificationBell home={home} tone="light" icon="line" />
        <StaffAccountMenu loginPath={login} />
      </div>
    </header>
  );
}
