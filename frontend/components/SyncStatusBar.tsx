"use client";
// Sync status indicator for the officer portal header (Story 4.1, FR-8.4). Localized si/ta/en
// (Story 6.2, FR-9.1) via the officer i18n provider (Story 6.1) — strings from
// `officer.syncBar`. Drives the actual retry loop too: every poll tick (and the `online` event)
// calls runSync() so a due item is retried even if the officer never looks at this bar.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { getLastSyncedAt, getQueuedItems, runSync } from "@/lib/syncQueue";

const POLL_MS = 10_000;

export function SyncStatusBar() {
  const t = useTranslations("officer");
  const locale = useLocale();
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;

    async function tick() {
      const token = await getAccessToken();
      if (token) await runSync(token).catch(() => {});
      const [items, lastSyncedAt] = await Promise.all([
        getQueuedItems().catch(() => []),
        getLastSyncedAt().catch(() => null),
      ]);
      if (!active) return;
      setPendingCount(items.filter((i) => i.status === "pending" || i.status === "in_progress").length);
      setFailedCount(items.filter((i) => i.status === "failed").length);
      if (lastSyncedAt !== null) setLastSynced(new Date(lastSyncedAt));
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

  // `status: "failed"` is only ever set once an item has exhausted its retry budget
  // (see recordFailedAttempt in lib/syncQueue.ts), so failedCount > 0 already means
  // "exceeded 5 attempts" — no need for a separate live-event flag that would reset (and
  // lose the notification) on every fresh mount/reload.
  if (failedCount > 0) {
    // role="alert" belongs on a non-interactive live-region wrapper — putting it directly on
    // the <Link> would override its native "link" role in the accessibility tree, hiding from
    // screen readers that it's clickable (2026-07-09 code review).
    return (
      <div role="alert" className="sticky top-0 z-50 w-full bg-status-error">
        <Link
          href="/officer/sync"
          className="block w-full px-design-4 py-design-2 text-center text-label text-ink-on-dark"
        >
          {t("syncBar.failed")}
        </Link>
      </div>
    );
  }

  if (pendingCount > 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="sticky top-0 z-50 flex w-full items-center justify-center gap-design-2 bg-amber px-design-4 py-design-2 text-center text-label text-ink-on-amber"
      >
        <span className="animate-spin" aria-hidden="true">
          ⟳
        </span>
        {t("syncBar.pending", { count: pendingCount })}
      </div>
    );
  }

  if (!lastSynced) return null;

  return (
    <div role="status" className="sticky top-0 z-50 w-full bg-forest-pale px-design-4 py-design-2 text-center text-label text-forest">
      {t("syncBar.synced", { time: lastSynced.toLocaleTimeString(locale) })}
    </div>
  );
}
