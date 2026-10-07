"use client";
// The in-app notification surface, for every role.
//
// WHY A BELL AND NOT JUST WEB PUSH. A push notification is an operating-system toast: it appears
// once and is gone. Someone who dismissed it, never granted permission, or had the tab closed has
// no way to recover what they were told. On this platform that matters more than usual, because the
// thing being announced is a compensation claim moving through a queue that a family is waiting on.
//
// It reads the same audit rows the push path writes, so the list is accurate even where push was
// never enabled — which is the normal state for most of these accounts.
//
// ONE FETCH PER LAYOUT, NOT PER PAGE. AdminShell deliberately kept badge counts out of the sidebar
// because they would have cost an authenticated fetch on every page render. This is mounted once in
// each role's layout and polls slowly while closed, so navigating between pages costs nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bell } from "@phosphor-icons/react";
import {
  fetchNotifications,
  isKnownSubject,
  readLastSeenId,
  unreadCount,
  writeLastSeenId,
  type NotificationItem,
} from "@/lib/notificationFeed";

/** Slow on purpose: nothing here is time-critical, and the push channel already covers "right
 *  now". The bell is for catching up. */
const POLL_MS = 60_000;

type Tone = "dark" | "light";

/** Where a notification takes you. Staff rows carry a case reference; the citizen's own claims
 *  live on one page, so theirs goes there. */
function targetFor(item: NotificationItem, home: string): string {
  if (!item.canonical_id) return home;
  return home.includes("?") ? `${home}&ref=${item.canonical_id}` : `${home}?ref=${item.canonical_id}`;
}

export default function NotificationBell({
  home,
  tone = "dark",
  icon = "emoji",
}: {
  /** Where an entry links to — the role's case list. */
  home: string;
  /** `dark` sits on the forest top bar, `light` on a pale page header. */
  tone?: Tone;
  /** `line` is the staff bars' outline icon (admin redesign, 2026-10-07); citizen and officer
   *  pages keep the emoji they were designed with. */
  icon?: "emoji" | "line";
}) {
  const t = useTranslations("notifications");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [lastSeen, setLastSeen] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  /** -> true when there was a session to read. The caller uses that to decide whether to keep
   *  trying: see the retry below. */
  const load = useCallback(async () => {
    const result = await fetchNotifications();
    if (!mounted.current) return true;
    if (result.ok) {
      setItems(result.notifications);
      setFailed(false);
      return true;
    }
    if (result.failure.reason === "no-session") return false;
    // Signed out is not a failure worth showing in the chrome — the page itself handles it.
    setFailed(result.failure.reason !== "signed-out");
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    setLastSeen(readLastSeenId());

    // THE SESSION IS NOT READY AT MOUNT, and this is the moment the bell matters most. The layout
    // renders as soon as the route changes, while @supabase/ssr is still reading the session out of
    // the cookie store, so the first read returns no token. Falling through to the slow poll left
    // the bell empty for a full minute immediately after signing in — which is exactly when someone
    // looks at it. Retry briefly instead, then settle into the poll.
    let attempts = 0;
    let retry: number | undefined;
    const attempt = async () => {
      const hadSession = await load();
      if (!hadSession && mounted.current && attempts < 5) {
        attempts += 1;
        retry = window.setTimeout(() => void attempt(), 1500);
      }
    };
    void attempt();

    const timer = window.setInterval(() => {
      if (!open) void load();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [load, open]);

  // Outside-click and Escape, same mechanics as StaffAccountMenu.
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

  const unread = unreadCount(items, lastSeen);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Marked read on OPEN, not on close: the viewer has seen the list the moment it renders, and
    // marking on close would leave them unread if the panel is dismissed with Escape.
    if (next && items.length > 0) {
      const highest = items[0].id;
      writeLastSeenId(highest);
      setLastSeen(highest);
    }
  }

  const buttonTone =
    tone === "dark"
      ? "text-ink-on-dark hover:bg-white/10"
      : "text-ink-primary hover:bg-surface-tint";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="notification-panel"
        aria-label={unread > 0 ? t("bellWithCount", { count: unread }) : t("bell")}
        onClick={toggle}
        className={`relative flex min-h-touch-target min-w-touch-target items-center justify-center rounded-md px-design-2 transition-colors ${buttonTone}`}
        data-testid="notification-bell"
      >
        {icon === "line" ? (
          <Bell aria-hidden="true" size={20} />
        ) : (
          <span aria-hidden="true" className="text-[20px] leading-none">
            🔔
          </span>
        )}
        {unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute right-0 top-0 min-w-[1.25rem] rounded-pill bg-amber px-1 text-center text-caption font-bold leading-5 text-ink-on-amber"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notification-panel"
          role="region"
          aria-label={t("bell")}
          className="absolute right-0 top-full z-50 mt-design-2 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border-subtle bg-surface-raised p-design-3 shadow-lg"
        >
          <p className="mb-design-2 text-label font-semibold text-ink-primary">{t("bell")}</p>

          {failed && (
            <p role="alert" className="text-caption text-status-error">
              {t("feedUnavailable")}
            </p>
          )}

          {!failed && items.length === 0 && (
            <p className="text-caption text-ink-secondary">{t("feedEmpty")}</p>
          )}

          <ul className="flex flex-col gap-design-1">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={targetFor(item, home)}
                  onClick={() => setOpen(false)}
                  className={`block rounded-sm px-design-2 py-design-2 transition-colors hover:bg-surface-tint ${
                    item.id > lastSeen ? "border-l-2 border-amber" : ""
                  }`}
                >
                  <span className="block text-label text-ink-primary">
                    {isKnownSubject(item.subject)
                      ? t(`subjects.${item.subject}`)
                      : item.subject ?? item.event}
                  </span>
                  <span className="block text-caption text-ink-secondary">
                    {item.canonical_id ?? ""}
                    {item.created_at
                      ? ` · ${new Date(item.created_at).toLocaleString()}`
                      : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
