"use client";

// Single row on the officer Sync Queue screen (Story 4.4, FR-8.4/8.5). Localized si/ta/en
// (Story 6.2, FR-9.1) via the officer i18n provider (Story 6.1) — strings from
// `officer.syncItem`. The damage category value is a data value (crop/property/…) and is shown
// via its `officer.syncItem.damageLabel` wrapper; district/DS names are never routed here.
import { useTranslations, useLocale } from "next-intl";
import type { SyncQueueItem } from "@/lib/indexeddb";

const STATUS_STYLES: Record<SyncQueueItem["status"], string> = {
  pending: "bg-amber-pale text-amber",
  in_progress: "bg-forest-pale text-forest",
  failed: "bg-status-error-pale text-status-error",
};

const STATUS_LABEL_KEYS: Record<SyncQueueItem["status"], string> = {
  pending: "syncItem.statusPending",
  in_progress: "syncItem.statusInProgress",
  failed: "syncItem.statusFailed",
};

interface Props {
  item: SyncQueueItem;
  onRetry: (id: number) => void;
}

export function SyncQueueItemCard({ item, onRetry }: Props) {
  const t = useTranslations("officer");
  const locale = useLocale();
  const canRetry = item.status === "failed" || item.status === "pending";
  const damageCategory = (item.payload?.damage_category as string) ?? t("syncItem.unknownDamage");
  const rawTimestamp = item.payload?.timestamp_local as string | undefined;
  const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp) : null;
  const hasValidTimestamp = parsedTimestamp !== null && !Number.isNaN(parsedTimestamp.getTime());
  const damageLabel = t("syncItem.damageLabel", { category: damageCategory });

  return (
    <div
      data-testid="sync-queue-item"
      className="rounded-lg border border-border-default bg-surface-raised p-design-4 space-y-design-2"
    >
      <div className="flex items-center justify-between gap-design-2">
        <p className="text-body font-medium text-ink-primary capitalize">{damageLabel}</p>
        <span className={`text-label px-design-2 py-1 rounded-full ${STATUS_STYLES[item.status]}`}>
          {t(STATUS_LABEL_KEYS[item.status])}
        </span>
      </div>

      {hasValidTimestamp && (
        <p className="text-label text-ink-disabled">{parsedTimestamp!.toLocaleString(locale)}</p>
      )}

      {item.sync_attempts > 0 && (
        <p className="text-label text-ink-secondary">
          {t("syncItem.attempts", { count: item.sync_attempts })}
        </p>
      )}

      {/* Sanitized, user-friendly text only — the raw last_error is stored in IDB for
          debugging but never rendered (CRITICAL #3). */}
      {item.status === "failed" && item.last_error && (
        <p className="text-label text-status-error">{t("syncItem.connectionFailed")}</p>
      )}

      {canRetry && (
        <button
          type="button"
          onClick={() => onRetry(item.id)}
          aria-label={t("syncItem.retryAria", { category: damageCategory })}
          className="w-full min-h-touch-target bg-forest text-ink-on-dark text-label font-semibold rounded-md mt-design-2"
        >
          {t("syncItem.retry")}
        </button>
      )}
    </div>
  );
}
