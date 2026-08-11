"use client";

// Officer tab bar (officer-camera.html mockup). Mounted once in app/officer/layout.tsx — the
// dashboard / submit / classify / sync routes previously had no chrome linking them to each
// other at all.
//
// Mockup parity note: the mockup's fourth tab is "Settings", which has no officer route. The
// on-device classification screen — the officer's most-used destination and the subject of that
// same mockup — takes the slot instead of a link to a 404.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { getQueuedItems } from "@/lib/syncQueue";
import { BottomNav, BottomNavItemBody, bottomNavItemClass } from "@/components/BottomNav";

const POLL_MS = 10_000;

// Login is a focused auth flow; the officer PoC hand-off screen is a terminal receipt (same
// reasoning as the citizen PoC — see CitizenBottomNav).
const HIDDEN_ON = ["/officer/login", "/officer/submit/poc"];

const TABS = [
  { href: "/officer/dashboard", icon: "🏠", labelKey: "navDashboard" },
  { href: "/officer/submit", icon: "📝", labelKey: "navNewReport" },
  { href: "/officer/classify", icon: "🤖", labelKey: "navClassify" },
  { href: "/officer/sync", icon: "📤", labelKey: "navQueue", badge: true },
] as const;

export function OfficerBottomNav() {
  const t = useTranslations("officer");
  const pathname = usePathname();
  const [queueCount, setQueueCount] = useState(0);

  // Polls the queue for the badge count ONLY — deliberately does not call runSync(). The
  // SyncStatusBar already drives the retry loop on the same cadence; firing it from here too
  // would double every sync attempt.
  useEffect(() => {
    let active = true;
    async function tick() {
      const items = await getQueuedItems().catch(() => []);
      if (!active) return;
      // Every queued item is outstanding by construction — a synced item is removed from the
      // queue rather than kept with a "synced" status (getQueuedItems only ever yields
      // pending / in_progress / failed), so the badge is simply the queue length.
      setQueueCount(items.length);
    }
    tick();
    const interval = setInterval(tick, POLL_MS);
    window.addEventListener("online", tick);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("online", tick);
    };
  }, []);

  if (!pathname) return null;
  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  if (!pathname.startsWith("/officer")) return null;

  return (
    <BottomNav ariaLabel={t("navAria")}>
      {TABS.map((tab) => {
        // /officer/submit must not light up while on /officer/submit/poc — but that route is
        // in HIDDEN_ON anyway, so a prefix match is safe and keeps nested routes highlighted.
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={bottomNavItemClass(active)}
          >
            <BottomNavItemBody
              icon={tab.icon}
              label={t(tab.labelKey)}
              active={active}
              badge={"badge" in tab && tab.badge ? queueCount : null}
            />
          </Link>
        );
      })}
    </BottomNav>
  );
}
