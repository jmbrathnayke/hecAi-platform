import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SyncQueuePage from "../page";
import { getAccessToken } from "@/lib/auth";

// next-intl passthrough (Story 6.2): translator returns the key (+ interpolation values). Covers
// the page and the REAL SyncQueueItemCard (requireActual'd below).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));
import { getLastSyncedAt, getQueuedItems, retryItem } from "@/lib/syncQueue";
import { SyncQueueItemCard } from "@/components/SyncQueueItem";

jest.mock("@/lib/auth", () => ({
  getAccessToken: jest.fn(),
}));

jest.mock("@/lib/syncQueue", () => ({
  getLastSyncedAt: jest.fn(),
  getQueuedItems: jest.fn(),
  retryItem: jest.fn(),
}));

// Wraps the REAL component in a jest.fn so tests can assert on render/call counts (proving
// the CRITICAL #4 re-render bail-out actually works) while every other test still exercises
// real rendered output (2026-07-09 code review — the prior test only proved DOM-node
// identity, which React's keyed reconciliation preserves regardless of the bail-out).
jest.mock("@/components/SyncQueueItem", () => {
  const actual = jest.requireActual("@/components/SyncQueueItem");
  return { SyncQueueItemCard: jest.fn(actual.SyncQueueItemCard) };
});

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
  (SyncQueueItemCard as jest.Mock).mockClear();
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows the empty state with the last-sync timestamp when the queue is empty", async () => {
  mockGetLastSyncedAt.mockResolvedValue(new Date("2026-07-09T10:00:00.000Z").getTime());
  render(<SyncQueuePage />);
  expect(await screen.findByText("syncPage.allSynced")).toBeInTheDocument();
  expect(await screen.findByText(/syncPage.lastSync/)).toBeInTheDocument();
});

test("lists queued items with status, attempt count, and a Failed badge", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);
  expect(await screen.findByText("syncItem.damageLabel crop")).toBeInTheDocument();
  expect(screen.getByText("syncItem.statusFailed")).toBeInTheDocument();
  expect(screen.getByText("syncItem.attempts 6")).toBeInTheDocument();
});

test("tapping Retry on a failed item calls retryItem with the id and the access token, then shows a success toast", async () => {
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);

  const retryButton = await screen.findByRole("button", { name: /retry/i });
  fireEvent.click(retryButton);

  await waitFor(() => expect(mockRetryItem).toHaveBeenCalledWith(1, "tok-1"));
  expect(await screen.findByText("syncPage.syncedSuccess")).toBeInTheDocument();
});

test("does not call retryItem while offline — shows an offline message instead", async () => {
  Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);

  fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

  expect(await screen.findByText("syncPage.offlineRetry")).toBeInTheDocument();
  expect(mockRetryItem).not.toHaveBeenCalled();
});

test("the 5s poll picks up an item synced elsewhere without a page reload", async () => {
  mockGetQueuedItems.mockResolvedValueOnce([item()]).mockResolvedValue([]);
  render(<SyncQueuePage />);
  expect(await screen.findByText("syncItem.damageLabel crop")).toBeInTheDocument();

  await jest.advanceTimersByTimeAsync(5_000);

  await waitFor(() => expect(screen.queryByText("syncItem.damageLabel crop")).not.toBeInTheDocument());
  expect(screen.getByText("syncPage.allSynced")).toBeInTheDocument();
});

test("a poll tick with no actual change does not re-render SyncQueueItemCard", async () => {
  // 2026-07-09 code review fix: proves the CRITICAL #4 bail-out by counting actual render
  // (call) invocations of the child component, not just DOM node identity.
  mockGetQueuedItems.mockResolvedValue([item()]);
  render(<SyncQueuePage />);
  await screen.findByTestId("sync-queue-item");
  const callsBeforePoll = (SyncQueueItemCard as jest.Mock).mock.calls.length;

  await jest.advanceTimersByTimeAsync(5_000);
  await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalledTimes(2));

  expect((SyncQueueItemCard as jest.Mock).mock.calls.length).toBe(callsBeforePoll);
});

// 2026-07-09 code review patches below.

describe("optimistic UI (AC2 / CRITICAL #2)", () => {
  test("shows the item as Syncing immediately, before retryItem resolves", async () => {
    let resolveRetry!: () => void;
    mockRetryItem.mockReturnValue(new Promise<void>((resolve) => { resolveRetry = resolve; }));
    mockGetQueuedItems.mockResolvedValue([item()]);
    render(<SyncQueuePage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("syncItem.statusInProgress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();

    resolveRetry();
    await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalledTimes(2));
  });
});

describe("differentiated error toasts (2026-07-09 code review)", () => {
  test("a generic/network failure shows the connection message", async () => {
    mockGetQueuedItems.mockResolvedValue([item()]);
    mockRetryItem.mockRejectedValue(new Error("offline"));
    render(<SyncQueuePage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("syncPage.retryFailed")).toBeInTheDocument();
  });

  test("an HTTP error shows a server-error message, not a connection message", async () => {
    mockGetQueuedItems.mockResolvedValue([item()]);
    mockRetryItem.mockRejectedValue(new Error("HTTP 500"));
    render(<SyncQueuePage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("syncPage.errorServer")).toBeInTheDocument();
    expect(screen.queryByText("syncPage.retryFailed")).not.toBeInTheDocument();
  });

  test("a server-side 'not confirmed' failure shows a distinct message, not a connection message", async () => {
    mockGetQueuedItems.mockResolvedValue([item()]);
    mockRetryItem.mockRejectedValue(new Error("not confirmed by server"));
    render(<SyncQueuePage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("syncPage.errorNotConfirmed")).toBeInTheDocument();
  });

  test("an 'already in progress' guard failure shows a distinct message", async () => {
    mockGetQueuedItems.mockResolvedValue([item()]);
    mockRetryItem.mockRejectedValue(new Error("Retry already in progress"));
    render(<SyncQueuePage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByText("syncPage.errorInProgress")).toBeInTheDocument();
  });
});

describe("load failure (CRITICAL: safety-net screen must not falsely claim success)", () => {
  test("a real IndexedDB read failure shows an error state, never the 'All reports synced' success state", async () => {
    mockGetQueuedItems.mockRejectedValue(new Error("IDB transaction aborted"));
    render(<SyncQueuePage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/syncPage.loadError/i);
    expect(screen.queryByText("syncPage.allSynced")).not.toBeInTheDocument();
  });

  test("recovers to the normal empty state once a later poll succeeds", async () => {
    mockGetQueuedItems.mockRejectedValueOnce(new Error("IDB transaction aborted")).mockResolvedValue([]);
    render(<SyncQueuePage />);
    await screen.findByRole("alert");

    await jest.advanceTimersByTimeAsync(5_000);

    expect(await screen.findByText("syncPage.allSynced")).toBeInTheDocument();
  });
});
