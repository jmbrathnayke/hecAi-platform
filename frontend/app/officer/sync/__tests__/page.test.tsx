import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SyncQueuePage from "../page";
import { getAccessToken } from "@/lib/auth";
import { getLastSyncedAt, getQueuedItems, retryItem } from "@/lib/syncQueue";

jest.mock("@/lib/auth", () => ({
  getAccessToken: jest.fn(),
}));

jest.mock("@/lib/syncQueue", () => ({
  getLastSyncedAt: jest.fn(),
  getQueuedItems: jest.fn(),
  retryItem: jest.fn(),
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockGetLastSyncedAt = getLastSyncedAt as jest.Mock;
const mockGetQueuedItems = getQueuedItems as jest.Mock;
const mockRetryItem = retryItem as jest.Mock;

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    offline_id: "off-1",
    payload: { damage_category: "crop" },
    status: "failed",
    sync_attempts: 6,
    last_error: "HTTP 500",
    queued_at: 1000,
    next_attempt_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-1");
  mockGetLastSyncedAt.mockReset().mockResolvedValue(null);
  mockGetQueuedItems.mockReset().mockResolvedValue([]);
  mockRetryItem.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows the empty state with the last-sync timestamp when the queue is empty", async () => {
  mockGetLastSyncedAt.mockResolvedValue(new Date("2026-07-09T10:00:00.000Z").getTime());
  render(<SyncQueuePage />);
  expect(await screen.findByText("All reports synced")).toBeInTheDocument();
  expect(await screen.findByText(/Last sync:/)).toBeInTheDocument();
});

test("lists queued items with status, attempt count, and a Failed badge", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);
  expect(await screen.findByText("crop damage")).toBeInTheDocument();
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("6 attempts")).toBeInTheDocument();
});

test("tapping Retry on a failed item calls retryItem with the id and the access token, then shows a success toast", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);

  const retryButton = await screen.findByRole("button", { name: /retry/i });
  fireEvent.click(retryButton);

  await waitFor(() => expect(mockRetryItem).toHaveBeenCalledWith(1, "tok-1"));
  expect(await screen.findByText("Report synced successfully")).toBeInTheDocument();
});

test("shows an inline retry-failed toast when retryItem rejects", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  mockRetryItem.mockRejectedValue(new Error("HTTP 500"));
  render(<SyncQueuePage />);

  fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

  expect(await screen.findByText("Retry failed. Check your connection.")).toBeInTheDocument();
});

test("does not call retryItem while offline — shows an offline message instead", async () => {
  Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);

  fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

  expect(await screen.findByText("You are offline — retry when connected")).toBeInTheDocument();
  expect(mockRetryItem).not.toHaveBeenCalled();
});

test("the 5s poll picks up an item synced elsewhere without a page reload", async () => {
  mockGetQueuedItems.mockResolvedValueOnce([item()]).mockResolvedValue([]);
  render(<SyncQueuePage />);
  expect(await screen.findByText("crop damage")).toBeInTheDocument();

  await jest.advanceTimersByTimeAsync(5_000);

  await waitFor(() => expect(screen.queryByText("crop damage")).not.toBeInTheDocument());
  expect(screen.getByText("All reports synced")).toBeInTheDocument();
});

test("a poll tick with no actual change does not re-render the list", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);
  const before = await screen.findByTestId("sync-queue-item");

  await jest.advanceTimersByTimeAsync(5_000);
  await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalledTimes(2));

  const after = screen.getByTestId("sync-queue-item");
  expect(after).toBe(before);
});
