import { render, screen, waitFor } from "@testing-library/react";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { getAccessToken } from "@/lib/auth";
import { getLastSyncedAt, getQueuedItems, runSync } from "@/lib/syncQueue";

// next-intl passthrough (Story 6.2): translator returns the key (+ interpolation values).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

jest.mock("@/lib/auth", () => ({
  getAccessToken: jest.fn(),
}));

jest.mock("@/lib/syncQueue", () => ({
  getLastSyncedAt: jest.fn(),
  getQueuedItems: jest.fn(),
  runSync: jest.fn(),
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockGetLastSyncedAt = getLastSyncedAt as jest.Mock;
const mockGetQueuedItems = getQueuedItems as jest.Mock;
const mockRunSync = runSync as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-1");
  mockGetLastSyncedAt.mockReset().mockResolvedValue(null);
  mockGetQueuedItems.mockReset().mockResolvedValue([]);
  mockRunSync.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

test("renders nothing when the queue is empty and nothing has ever synced", async () => {
  const { container } = render(<SyncStatusBar />);
  await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("shows the pending count with a spinner while items are queued", async () => {
  mockGetQueuedItems.mockResolvedValue([
    { id: 1, offline_id: "a", payload: {}, status: "pending", sync_attempts: 0, queued_at: 1, next_attempt_at: 0 },
    { id: 2, offline_id: "b", payload: {}, status: "in_progress", sync_attempts: 1, queued_at: 1, next_attempt_at: 0 },
  ]);
  render(<SyncStatusBar />);
  expect(await screen.findByText("syncBar.pending 2")).toBeInTheDocument();
});

test("shows the synced state with the last-sync time once the queue drains", async () => {
  // A confirmed sync deletes the sync_queue row outright (see runSync), so the "last
  // synced" timestamp is read from getLastSyncedAt(), not from any queue item.
  mockGetQueuedItems.mockResolvedValue([]);
  mockGetLastSyncedAt.mockResolvedValue(new Date("2026-07-08T09:30:00.000Z").getTime());
  render(<SyncStatusBar />);
  expect(await screen.findByText(/syncBar.synced/)).toBeInTheDocument();
});

test("shows the max-attempts notice for a failed item, even on a fresh mount (no live event needed)", async () => {
  // status: "failed" is only ever set once an item has exhausted 5 attempts (see
  // recordFailedAttempt), so this must render from queue state alone — an officer who
  // reopens the app after items already failed (no hec-sync-failed event fires this
  // session) must still see the actionable message, not a generic count.
  mockGetQueuedItems.mockResolvedValue([
    { id: 1, offline_id: "a", payload: {}, status: "failed", sync_attempts: 6, queued_at: 1, next_attempt_at: 0 },
  ]);
  render(<SyncStatusBar />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "syncBar.failed",
  );
});

test("the max-attempts notice is a live link to the Sync Queue screen (Story 4.4)", async () => {
  // 2026-07-09 code review: role="alert" belongs on the non-interactive wrapper, not the
  // <Link> itself (ARIA misuse would strip its link semantics) — so the alert and the link
  // are two separate, correctly-roled elements.
  mockGetQueuedItems.mockResolvedValue([
    { id: 1, offline_id: "a", payload: {}, status: "failed", sync_attempts: 6, queued_at: 1, next_attempt_at: 0 },
  ]);
  render(<SyncStatusBar />);
  await screen.findByRole("alert");
  const link = screen.getByRole("link", { name: /syncBar.failed/i });
  expect(link).toHaveAttribute("href", "/officer/sync");
});

test("calls runSync with the access token on the poll tick", async () => {
  render(<SyncStatusBar />);
  await waitFor(() => expect(mockRunSync).toHaveBeenCalledWith("tok-1"));
});

test("does not call runSync when there is no session token", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<SyncStatusBar />);
  await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalled());
  expect(mockRunSync).not.toHaveBeenCalled();
});
