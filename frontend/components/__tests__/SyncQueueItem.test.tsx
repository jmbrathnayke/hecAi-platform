import { fireEvent, render, screen } from "@testing-library/react";
import { SyncQueueItemCard } from "@/components/SyncQueueItem";
import type { SyncQueueItem } from "@/lib/indexeddb";

function item(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return {
    id: 1,
    offline_id: "off-1",
    payload: { damage_category: "crop", timestamp_local: "2026-07-09T10:00:00.000Z" },
    status: "pending",
    sync_attempts: 0,
    queued_at: 1000,
    next_attempt_at: 0,
    ...overrides,
  };
}

test("renders damage category, timestamp, and a Pending badge", () => {
  render(<SyncQueueItemCard item={item()} onRetry={jest.fn()} />);
  expect(screen.getByText("crop damage")).toBeInTheDocument();
  expect(screen.getByText("Pending")).toBeInTheDocument();
});

test("shows a Syncing badge and hides Retry while in_progress", () => {
  render(<SyncQueueItemCard item={item({ status: "in_progress" })} onRetry={jest.fn()} />);
  expect(screen.getByText("Syncing...")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
});

test("shows the Failed badge, attempt count, and a sanitized error (never the raw last_error)", () => {
  render(
    <SyncQueueItemCard
      item={item({ status: "failed", sync_attempts: 3, last_error: "TypeError: NetworkError raw stack" })}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("3 attempts")).toBeInTheDocument();
  expect(screen.getByText("Connection failed. Try again.")).toBeInTheDocument();
  expect(screen.queryByText(/NetworkError raw stack/)).not.toBeInTheDocument();
});

test("Retry is visible for pending and failed items, and calls onRetry with the item id", () => {
  const onRetry = jest.fn();
  render(<SyncQueueItemCard item={item({ id: 42, status: "failed" })} onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(onRetry).toHaveBeenCalledWith(42);
});

test("singular 'attempt' when sync_attempts is 1", () => {
  render(<SyncQueueItemCard item={item({ sync_attempts: 1 })} onRetry={jest.fn()} />);
  expect(screen.getByText("1 attempt")).toBeInTheDocument();
});

test("omits the attempt count when sync_attempts is 0", () => {
  render(<SyncQueueItemCard item={item({ sync_attempts: 0 })} onRetry={jest.fn()} />);
  expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
});

// 2026-07-09 code review patches below.

test("Retry buttons for different items have distinct accessible names", () => {
  render(
    <>
      <SyncQueueItemCard item={item({ id: 1, status: "failed", payload: { damage_category: "crop" } })} onRetry={jest.fn()} />
      <SyncQueueItemCard item={item({ id: 2, status: "failed", payload: { damage_category: "property" } })} onRetry={jest.fn()} />
    </>,
  );
  expect(screen.getByRole("button", { name: "Retry crop damage report" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry property damage report" })).toBeInTheDocument();
});

test("renders no timestamp (and never 'Invalid Date') when timestamp_local is malformed", () => {
  render(
    <SyncQueueItemCard
      item={item({ payload: { damage_category: "crop", timestamp_local: "not-a-real-date" } })}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
});

test("renders no timestamp line when timestamp_local is absent", () => {
  render(<SyncQueueItemCard item={item({ payload: { damage_category: "crop" } })} onRetry={jest.fn()} />);
  expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
});
