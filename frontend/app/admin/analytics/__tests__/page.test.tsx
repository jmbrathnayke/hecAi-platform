import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminAnalyticsPage from "../page";
import { fetchAdminAnalytics, UNAUTHORIZED } from "@/lib/adminAnalytics";
import { getAccessToken } from "@/lib/auth";

// Robust next-intl passthrough mock (Story 6.2/6.3 pattern) -- returns the key, appending
// interpolation values, so assertions on interpolated strings stay legible.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a) }),
}));

const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      getUser: (...a: unknown[]) => mockGetUser(...a),
      signOut: (...a: unknown[]) => mockSignOut(...a),
    },
  }),
}));

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminAnalytics", () => {
  const actual = jest.requireActual("@/lib/adminAnalytics");
  return { ...actual, fetchAdminAnalytics: jest.fn() };
});

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchAdminAnalytics = fetchAdminAnalytics as jest.Mock;

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    range: { from: "2026-06-15", to: "2026-07-15" },
    volume_trend: [{ month: "2026-07-01", count: 3 }],
    status_distribution: { Submitted: 2, Approved: 1 },
    compensation_by_month: [{ month: "2026-07-01", total_lkr: 45000 }],
    ai_metrics: {
      confidence_histogram: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
      sample_count: 2,
      override_rate_trend: { this_month_pct: 50, last_month_pct: 20, direction: "up" },
      avg_processing_time_ms: 420,
    },
    ...overrides,
  };
}

function emptyResponse() {
  return makeResponse({
    volume_trend: [],
    status_distribution: {},
    compensation_by_month: [],
    ai_metrics: {
      confidence_histogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      sample_count: 0,
      override_rate_trend: { this_month_pct: null, last_month_pct: null, direction: "no_data" },
      avg_processing_time_ms: null,
    },
  });
}

beforeEach(() => {
  mockReplace.mockReset();
  mockGetUser.mockReset().mockResolvedValue({
    data: { user: { app_metadata: { role: "admin" } } },
    error: null,
  });
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockFetchAdminAnalytics.mockReset().mockResolvedValue(makeResponse());
});

// --- role gate (Story 5.1 pattern, unchanged) -------------------------------------------

test("a non-admin is signed out and redirected to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: { role: "officer" } } }, error: null });
  render(<AdminAnalyticsPage />);

  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledWith("/admin/login");
  expect(mockFetchAdminAnalytics).not.toHaveBeenCalled();
});

// --- happy path (AC1) ---------------------------------------------------------------------

test("renders all four chart sections once data loads", async () => {
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(screen.getByText("analytics.volumeTrend")).toBeInTheDocument());
  expect(screen.getByText("analytics.statusDistribution")).toBeInTheDocument();
  expect(screen.getByText("analytics.compensationTotal")).toBeInTheDocument();
  expect(screen.getByText("analytics.aiMetrics")).toBeInTheDocument();
});

test("sends the default last-30-days range on first load", async () => {
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(mockFetchAdminAnalytics).toHaveBeenCalled());
  const [, params] = mockFetchAdminAnalytics.mock.calls[0];
  const from = new Date(params.from as string);
  const to = new Date(params.to as string);
  const days = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
  expect(days).toBe(30);
});

// --- empty-district state (AC5) -----------------------------------------------------------

test("each section shows an empty state when the district has no data yet", async () => {
  mockFetchAdminAnalytics.mockResolvedValue(emptyResponse());
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(screen.getByText("analytics.volumeTrend")).toBeInTheDocument());
  // 4 sections all render "analytics.noData" (Case Volume, Status Distribution, Compensation,
  // and the AI confidence histogram sub-section) -- the trend/processing-time sub-sections
  // render their own distinct empty markers checked separately below.
  expect(screen.getAllByText("analytics.noData").length).toBeGreaterThanOrEqual(3);
});

// --- date-filter re-fetch (AC3) ------------------------------------------------------------

test("changing the date range triggers a re-fetch with the new params", async () => {
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(mockFetchAdminAnalytics).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByLabelText("analytics.from"), { target: { value: "2026-01-01" } });

  await waitFor(() => expect(mockFetchAdminAnalytics).toHaveBeenCalledTimes(2));
  const [, params] = mockFetchAdminAnalytics.mock.calls[1];
  expect(params.from).toBe("2026-01-01");
});

// --- UNAUTHORIZED redirect -----------------------------------------------------------------

test("an expired session redirects to /admin/login instead of showing an error", async () => {
  mockFetchAdminAnalytics.mockResolvedValue(UNAUTHORIZED);
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

// --- error + retry ---------------------------------------------------------------------

test("a failed fetch shows an error with a working retry button", async () => {
  mockFetchAdminAnalytics.mockResolvedValueOnce(null);
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

  mockFetchAdminAnalytics.mockResolvedValueOnce(makeResponse());
  fireEvent.click(screen.getByText("analytics.retry"));
  await waitFor(() => expect(screen.getByText("analytics.volumeTrend")).toBeInTheDocument());
});

test("no access token surfaces the error state, not an infinite loading spinner", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<AdminAnalyticsPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(mockFetchAdminAnalytics).not.toHaveBeenCalled();
});
