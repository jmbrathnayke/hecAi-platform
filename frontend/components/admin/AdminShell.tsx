"use client";

// Admin navigation chrome: a light top bar and a left sidebar, mounted in app/admin/layout.tsx
// so every admin screen carries it.
//
// REDESIGN (2026-10-07, "keep the green, modernise"). The forest top bar and the emoji icons gave
// way to a quiet light bar with one accent:
//   - the language switch moved here from the body of every page, as one segmented control;
//   - this device's notification switch moved into the account menu, where the case list used to
//     carry it as a full-width card above the cases;
//   - icons are Phosphor line icons, so they render the same on every OS;
//   - the district the administrator is scoped to sits next to the brand, so every page says
//     whose cases these are.
// Destinations, labels and URLs are unchanged.
//
// Responsive behaviour: the 240px sidebar is `hidden lg:flex`; below lg the same destinations
// appear as a horizontally-scrollable row under the top bar. No hamburger/drawer: with only three
// destinations a drawer would add a tap and a focus trap for nothing.
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartLineUp, Folders, MapPin, Sliders, type IconProps } from "@phosphor-icons/react";
import { StaffAccountMenu } from "@/components/StaffAccountMenu";
import { StaffBrandMark } from "@/components/StaffBrandMark";
import NotificationBell from "@/components/NotificationBell";
import { LanguageSelectorCookie } from "@/components/LanguageSelectorCookie";
import { readStaffAccount } from "@/lib/staffAccount";

interface NavLink {
  href: string;
  labelKey: "cases" | "analytics" | "settings";
  icon: ComponentType<IconProps>;
  section: "main" | "admin";
}

const LINKS: NavLink[] = [
  { href: "/admin/cases", labelKey: "cases", icon: Folders, section: "main" },
  { href: "/admin/analytics", labelKey: "analytics", icon: ChartLineUp, section: "main" },
  { href: "/admin/settings/caps", labelKey: "settings", icon: Sliders, section: "admin" },
];

// The login screen is a focused auth flow and must not render navigation to pages the visitor
// is not yet authorised for.
const CHROMELESS = ["/admin/login"];

export function AdminShell({ children }: { children: ReactNode }) {
  const t = useTranslations("admin");
  const pathname = usePathname();
  const chromeless = !pathname || CHROMELESS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const district = useDistrict(!chromeless);

  if (chromeless) {
    return <>{children}</>;
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-base">
      <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-design-3 border-b border-border-subtle bg-surface-raised px-design-3 sm:px-design-4">
        <Link
          href="/admin/cases"
          className="flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest"
        >
          <StaffBrandMark label={t("nav.brand")} compact />
        </Link>
        {district && (
          <span className="hidden items-center gap-design-1 rounded-sm bg-surface-base px-design-2 py-1 text-caption font-medium text-ink-secondary md:inline-flex">
            <MapPin aria-hidden="true" size={14} />
            {district}
          </span>
        )}
        <div className="ml-auto flex items-center gap-design-1 sm:gap-design-2">
          <LanguageSelectorCookie segmented />
          <NotificationBell home="/admin/cases" tone="light" icon="line" />
          <StaffAccountMenu loginPath="/admin/login" showPushToggle />
        </div>
      </header>

      {/* Mobile destination row — the sidebar's job below `lg`. overflow-x-auto so a fourth
          destination later scrolls instead of wrapping into a second bar. */}
      <nav
        aria-label={t("nav.aria")}
        className="flex gap-design-1 overflow-x-auto border-b border-border-subtle bg-surface-raised px-design-3 py-design-2 lg:hidden"
      >
        {LINKS.map((link) => {
          const Icon = link.icon;
          const active = isActive(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[40px] shrink-0 items-center gap-design-2 whitespace-nowrap rounded-sm px-design-3 text-label transition-colors duration-150 motion-reduce:transition-none ${
                active ? "bg-surface-tint font-semibold text-forest" : "font-medium text-ink-secondary hover:text-ink-primary"
              }`}
            >
              <Icon aria-hidden="true" size={18} weight={active ? "fill" : "regular"} />
              {t(`nav.${link.labelKey}`)}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("nav.aria")}
          className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-surface-raised px-design-3 py-design-4 lg:flex"
        >
          <SidebarSection label={t("nav.sectionMain")} first />
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

/** The administrator's district, read from the session once the shell is showing. */
function useDistrict(enabled: boolean): string | null {
  const [district, setDistrict] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void readStaffAccount().then((account) => {
      if (active && account?.role === "admin" && account.scope.length > 0) setDistrict(account.scope[0]);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  return district;
}

function SidebarSection({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <p className={`px-design-3 pb-design-1 text-caption font-medium text-ink-secondary ${first ? "" : "pt-design-5"}`}>
      {label}
    </p>
  );
}

function SidebarLink({ link, active, label }: { link: NavLink; active: boolean; label: string }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-h-[40px] items-center gap-design-3 rounded-sm px-design-3 text-label transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest motion-reduce:transition-none ${
        active
          ? "bg-surface-tint font-semibold text-forest"
          : "font-medium text-ink-secondary hover:bg-surface-base hover:text-ink-primary"
      }`}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-pill bg-forest" />}
      <Icon aria-hidden="true" size={18} weight={active ? "fill" : "regular"} />
      {label}
    </Link>
  );
}
