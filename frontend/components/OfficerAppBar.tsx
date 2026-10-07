"use client";

// The officer field app's top bar (redesign, 2026-10-07). It replaces the thin strip that held
// only the bell: the same light bar as the admin and DS portals, carrying the brand, the language
// switch (which used to sit in the body of the dashboard) and the notification bell. Hidden on the
// sign-in screen, which is a focused auth flow.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { StaffBrandMark } from "@/components/StaffBrandMark";
import NotificationBell from "@/components/NotificationBell";
import { LanguageSelectorCookie } from "@/components/LanguageSelectorCookie";

const HIDDEN_ON = ["/officer/login"];

export function OfficerAppBar() {
  const t = useTranslations("staffAccount");
  const pathname = usePathname();
  if (pathname && HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  return (
    <header
      className="flex h-14 shrink-0 items-center gap-design-2 border-b border-border-subtle bg-surface-raised px-design-3 sm:px-design-4 print:hidden"
      data-testid="officer-app-bar"
    >
      <Link
        href="/officer/dashboard"
        className="flex min-h-touch-target min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest"
      >
        <StaffBrandMark label={t("brand.officer")} compact />
      </Link>
      <div className="ml-auto flex items-center gap-design-1">
        <LanguageSelectorCookie segmented />
        <NotificationBell home="/officer/dashboard" tone="light" icon="line" />
      </div>
    </header>
  );
}
