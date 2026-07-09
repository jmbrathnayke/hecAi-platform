// Single row on the officer Sync Queue screen (Story 4.4, FR-8.4/8.5). English-only officer
// portal (FR-9.3) — plain strings, no next-intl, same convention as SyncStatusBar/dashboard.
import type { SyncQueueItem } from "@/lib/indexeddb";

const STATUS_STYLES: Record<SyncQueueItem["status"], string> = {
  pending: "bg-amber-pale text-amber",
  in_progress: "bg-forest-pale text-forest",
  failed: "bg-status-error-pale text-status-error",
};

const STATUS_LABELS: Record<SyncQueueItem["status"], string> = {
  pending: "Pending",
  in_progress: "Syncing...",
  failed: "Failed",
};

interface Props {
  item: SyncQueueItem;
  onRetry: (id: number) => void;
}

export function SyncQueueItemCard({ item, onRetry }: Props) {
  const canRetry = item.status === "failed" || item.status === "pending";
  const damageCategory = (item.payload?.damage_category as string) ?? "Unknown";
  const timestamp = item.payload?.timestamp_local as string | undefined;

  return (
    <div
      data-testid="sync-queue-item"
      className="rounded-lg border border-border-default bg-surface-raised p-design-4 space-y-design-2"
    >
      <div className="flex items-center justify-between gap-design-2">
        <p className="text-body font-medium text-ink-primary capitalize">{damageCategory} damage</p>
        <span className={`text-label px-design-2 py-1 rounded-full ${STATUS_STYLES[item.status]}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      {timestamp && (
        <p className="text-label text-ink-disabled">{new Date(timestamp).toLocaleString()}</p>
      )}

      {item.sync_attempts > 0 && (
        <p className="text-label text-ink-secondary">
          {item.sync_attempts} attempt{item.sync_attempts !== 1 ? "s" : ""}
        </p>
      )}

      {/* Sanitized, user-friendly text only — the raw last_error is stored in IDB for
          debugging but never rendered (CRITICAL #3). */}
      {item.status === "failed" && item.last_error && (
        <p className="text-label text-status-error">Connection failed. Try again.</p>
      )}

      {canRetry && (
        <button
          type="button"
          onClick={() => onRetry(item.id)}
          className="w-full min-h-touch-target bg-forest text-ink-on-dark text-label font-semibold rounded-md mt-design-2"
        >
          Retry
        </button>
      )}
    </div>
  );
}
