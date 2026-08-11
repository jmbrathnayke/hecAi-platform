"use client";

// Citizen tab bar (citizen-home.html mockup). Mounted once in app/[locale]/layout.tsx so every
// citizen screen carries it — before this, /my-cases and /status existed as routes with no
// navigational entry point from the home screen at all.
//
// Mockup parity note: the mockup's third tab is "Help" (❓ උදව්). There is no help route in the
// app and no help copy in any spec, so this uses the Check-Status screen — a real destination —
// as the third tab instead of shipping a link to a 404. Swap it back when a help page exists.
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/navigation";
import { BottomNav, BottomNavItemBody, bottomNavItemClass } from "@/components/BottomNav";

// Routes where the tab bar is suppressed: login is a focused auth flow, and the PoC receipt is
// a terminal screen that carries its own "Done — Return Home" CTA (and shows no tab bar in
// proof-of-claim.html).
const HIDDEN_ON = ["/login", "/report/poc"];

const TABS = [
  { href: "/", icon: "🏠", labelKey: "navHome" },
  { href: "/my-cases", icon: "📋", labelKey: "navMyClaims" },
  { href: "/status", icon: "🔍", labelKey: "navStatus" },
] as const;

export function CitizenBottomNav() {
  const t = useTranslations("home");
  // usePathname() from @/navigation returns the path WITHOUT the locale prefix, so these
  // comparisons stay locale-independent (a raw next/navigation pathname would be "/si/...").
  const pathname = usePathname();

  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  return (
    <BottomNav ariaLabel={t("navAria")}>
      {TABS.map(({ href, icon, labelKey }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={bottomNavItemClass(active)}
          >
            <BottomNavItemBody icon={icon} label={t(labelKey)} active={active} />
          </Link>
        );
      })}
    </BottomNav>
  );
}
