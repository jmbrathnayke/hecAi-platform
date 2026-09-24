"use client";

// Top bar for the Divisional Secretariat and System Administration trees, matching the admin
// shell's forest bar. Neither tree had any chrome, so there was nowhere to show who was signed in
// and no way to sign out. Hidden on each tree's login page, which is a focused auth flow.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { StaffAccountMenu } from "@/components/StaffAccountMenu";
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
    <header className="sticky top-0 z-50 flex h-16 shrink-0 items-center gap-design-3 bg-forest px-design-4 text-ink-on-dark shadow-md">
      <Link href={home} className="flex min-w-0 items-center gap-design-2 font-bold">
        <span className="text-[22px] leading-none" aria-hidden="true">
          🐘
        </span>
        <span className="truncate text-label">{t(`brand.${tree}`)}</span>
      </Link>
      {/* `ml-auto` moves here so the bell and the account menu travel together on the right.
          StaffAccountMenu keeps its own ml-auto, which becomes a no-op once the space is taken. */}
      <div className="ml-auto">
        <NotificationBell home={home} tone="dark" />
      </div>
      <StaffAccountMenu loginPath={login} />
    </header>
  );
}
