"use client";

// Citizen tab bar (citizen-home.html mockup). Mounted once in app/[locale]/layout.tsx so every
// citizen screen carries it — before this, /my-cases and /status existed as routes with no
// navigational entry point from the home screen at all.
//
// Mockup parity note: the mockup's third tab is "Help" (❓ උදව්). There is no help route in the
// app and no help copy in any spec, so this uses the Check-Status screen — a real destination —
// as the third tab instead of shipping a link to a 404. Swap it back when a help page exists.
//
// The fourth tab is the account: "Profile" for a signed-in citizen, "Sign in" for a guest. Until
// the session check answers it shows Profile, which middleware sends a guest to sign-in from anyway.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/navigation";
import { BottomNav, BottomNavItemBody, bottomNavItemClass } from "@/components/BottomNav";
import { getAccessToken } from "@/lib/auth";

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
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // Re-checked on every navigation, so signing in or out is reflected without a reload.
  useEffect(() => {
    let active = true;
    getAccessToken()
      .then((token) => {
        if (active) setSignedIn(Boolean(token));
      })
      .catch(() => {
        if (active) setSignedIn(false);
      });
    return () => {
      active = false;
    };
  }, [pathname]);

  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const account =
    signedIn === false
      ? { href: "/login" as const, icon: "🔑", label: t("navSignIn") }
      : { href: "/profile" as const, icon: "👤", label: t("navProfile") };
  const accountActive = pathname.startsWith("/profile");

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
      <Link
        href={account.href}
        prefetch={false}
        aria-current={accountActive ? "page" : undefined}
        className={bottomNavItemClass(accountActive)}
      >
        <BottomNavItemBody icon={account.icon} label={account.label} active={accountActive} />
      </Link>
    </BottomNav>
  );
}
