"use client";

// Admin navigation chrome (admin-cases.html mockup): sticky forest top bar + left sidebar.
// Mounted in app/admin/layout.tsx so every admin screen carries it — /admin/cases,
// /admin/analytics and /admin/settings/caps previously had no shared chrome and no links
// between them beyond one inline text link on the case list.
//
// Responsive behaviour (the mockup is desktop-only, so this part is an addition, not a
// translation): the 240px sidebar is `hidden lg:flex`; below lg the same destinations appear as
// a horizontally-scrollable row under the top bar. No hamburger/drawer — with only three
// destinations a drawer would add a tap and a focus trap for nothing.
//
// Mockup parity note: the sidebar's amber "needs review" badge counts are NOT rendered. Those
// numbers are district-scoped KPI data that only /admin/cases fetches; surfacing them here would
// mean a second authenticated fetch on every admin page purely for chrome.
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

interface NavLink {
  href: string;
  labelKey: "cases" | "analytics" | "settings";
  icon: string;
  section: "main" | "admin";
}

const LINKS: NavLink[] = [
  { href: "/admin/cases", labelKey: "cases", icon: "📁", section: "main" },
  { href: "/admin/analytics", labelKey: "analytics", icon: "📊", section: "main" },
  { href: "/admin/settings/caps", labelKey: "settings", icon: "⚙️", section: "admin" },
];

// The login screen is a focused auth flow and must not render navigation to pages the visitor
// is not yet authorised for.
const CHROMELESS = ["/admin/login"];

export function AdminShell({ children }: { children: ReactNode }) {
  const t = useTranslations("admin");
  const pathname = usePathname();

  if (!pathname || CHROMELESS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return <>{children}</>;
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-base">
      {/* Top bar */}
      <header className="sticky top-0 z-50 flex h-16 shrink-0 items-center gap-design-3 bg-forest px-design-4 text-ink-on-dark shadow-md">
        <Link href="/admin/cases" className="flex items-center gap-design-2 font-bold">
          <span className="text-[22px] leading-none" aria-hidden="true">
            🐘
          </span>
          <span className="text-label">{t("nav.brand")}</span>
        </Link>
      </header>

      {/* Mobile destination row — the sidebar's job below `lg`. overflow-x-auto so a fourth
          destination later scrolls instead of wrapping into a second bar. */}
      <nav
        aria-label={t("nav.aria")}
        className="flex gap-design-1 overflow-x-auto border-b border-border-subtle bg-surface-raised px-design-3 py-design-2 lg:hidden"
      >
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(link.href) ? "page" : undefined}
            className={`flex min-h-touch-target shrink-0 items-center gap-design-2 whitespace-nowrap rounded-md px-design-3 text-label ${
              isActive(link.href)
                ? "bg-forest-pale font-semibold text-forest"
                : "font-medium text-ink-secondary"
            }`}
          >
            <span aria-hidden="true">{link.icon}</span>
            {t(`nav.${link.labelKey}`)}
          </Link>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <nav
          aria-label={t("nav.aria")}
          className="hidden w-60 shrink-0 flex-col gap-design-1 border-r border-border-default bg-surface-raised p-design-3 lg:flex"
        >
          <SidebarSection label={t("nav.sectionMain")} />
          {LINKS.filter((l) => l.section === "main").map((link) => (
            <SidebarLink key={link.href} link={link} active={isActive(link.href)} label={t(`nav.${link.labelKey}`)} />
          ))}
          <SidebarSection label={t("nav.sectionAdmin")} />
          {LINKS.filter((l) => l.section === "admin").map((link) => (
            <SidebarLink key={link.href} link={link} active={isActive(link.href)} label={t(`nav.${link.labelKey}`)} />
          ))}
        </nav>

        {/* min-w-0 is load-bearing: without it this flex child refuses to shrink below its
            content's intrinsic width, and the case table's horizontal scroll container would
            stretch the whole page instead of scrolling inside itself. */}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function SidebarSection({ label }: { label: string }) {
  return (
    <p className="px-design-2 pb-design-1 pt-design-2 text-caption font-semibold uppercase tracking-wide text-ink-disabled">
      {label}
    </p>
  );
}

function SidebarLink({ link, active, label }: { link: NavLink; active: boolean; label: string }) {
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-touch-target items-center gap-design-2 rounded-md px-design-3 text-label ${
        active ? "bg-forest-pale font-semibold text-forest" : "font-medium text-ink-secondary hover:bg-surface-base"
      }`}
    >
      <span className="text-[18px]" aria-hidden="true">
        {link.icon}
      </span>
      {label}
    </Link>
  );
}
