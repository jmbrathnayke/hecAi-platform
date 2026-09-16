import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficerDashboardPage from "../page";

// next-intl passthrough (Story 6.1/6.2): translator returns the key (+ interpolation values so
// dynamic assertions like the "via {channel}" line still work). Covers both useTranslations
// namespaces the dashboard uses (officer + status).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

// The non-routed LanguageSelectorCookie in the header uses next/navigation's useRouter().refresh().
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

// getAccessToken supplies the Bearer token for the authenticated fetch.
const mockGetAccessToken = jest.fn();
jest.mock("@/lib/auth", () => ({
  getAccessToken: () => mockGetAccessToken(),
}));

// Session hook (officer identity/divisions header) — not under test here.
jest.mock("@/hooks/useOfficerSession", () => ({
  useOfficerSession: () => ({
    officer_id: "officer-1",
    assigned_divisions: ["Kandy"],
    loading: false,
  }),
}));

// ModelLoadStatus pulls in the TF.js model loader; stub it out for this test.
jest.mock("@/components/ModelLoadStatus", () => ({
  ModelLoadStatus: () => <div data-testid="model-load-status" />,
}));

const SAMPLE = {
  cases: [
    {
      canonical_id: "HEC-2026-0001",
      offline_id: "uuid-1",
      status: "Submitted",
      damage_category: "crop",
      submitted_via: "app",
      gps_lat: 7.29,
      gps_lng: 80.63,
      submitted_at: "2026-07-08T09:00:00.000Z",
      updated_at: "2026-07-08T09:00:00.000Z",
    },
  ],
  count: 1,
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // next/jest loads .env.local, so these happen to be set locally and are absent on CI. Pin them
  // so the "no Supabase config" branch below is entered deliberately, never by accident.
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
  };
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => SAMPLE,
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

/** Mirrors the backend's `{"error": "..."}` shape (app/api/v1/middleware/auth.py). */
function failure(status: number, code: string) {
  return { ok: false, status, json: async () => ({ error: code }) };
}

test("renders the officer's cases and sends the Bearer token", async () => {
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(screen.getByText("crop")).toBeInTheDocument();
  expect(screen.getByText(/dashboard.via app/)).toBeInTheDocument();

  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers.Authorization).toBe("Bearer tok-123");
});

test("shows the empty state when the officer has no cases", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ cases: [] }) });
  render(<OfficerDashboardPage />);
  expect(await screen.findByText(/dashboard.empty/i)).toBeInTheDocument();
});

// Each failure below used to render the same sentence and the same Retry button. These tests
// pin the distinctions: the message names the actual cause, the HTTP status and the backend's
// error code are on screen, and Retry appears only where retrying can change the outcome.

test("a 403 names the missing officer role, shows the code, and offers no Retry", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(failure(403, "forbidden"));
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.forbidden")).toBeInTheDocument();
  // The line that previously required opening DevTools to see.
  expect(screen.getByText("dashboard.error.detail 403 forbidden")).toBeInTheDocument();
  // A role claim is baked into the JWT at issue time; no amount of retrying mints one.
  expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /signIn/i })).not.toBeInTheDocument();
});

test("a 401 offers sign-in rather than Retry", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(failure(401, "token_expired"));
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.signedOut")).toBeInTheDocument();
  expect(screen.getByText("dashboard.error.detail 401 token_expired")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /signIn/i })).toHaveAttribute("href", "/officer/login");
  expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
});

test("a 500 blames the server, not the account, and stays retryable", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(failure(500, "server_error"));
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.server")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("a JWKS outage (500 server_misconfigured) reads as a server problem and stays retryable", async () => {
  // auth.py deliberately answers an unreachable JWKS endpoint with 500, not 401, so a transient
  // Supabase blip does not sign every officer out — which is exactly why this one is retryable.
  (global.fetch as jest.Mock).mockResolvedValue(failure(500, "server_misconfigured"));
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.serverMisconfigured")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("an unreachable API reads as a network failure, with no HTTP detail line", async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.network")).toBeInTheDocument();
  // There is no status to report — inventing one would be worse than omitting it.
  expect(screen.queryByText(/dashboard\.error\.detail/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("no session reads as not-signed-in and does not fetch", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.noSession")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(global.fetch).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /signIn/i })).toBeInTheDocument();
});

test("missing Supabase config is not reported as an expired session", async () => {
  // getAccessToken() returns null for this too, so without its own branch the page would send
  // the user to a login page that cannot sign them in either.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("dashboard.error.config")).toBeInTheDocument();
  expect(mockGetAccessToken).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /signIn/i })).not.toBeInTheDocument();
});

test("Retry re-fetches after an error and recovers", async () => {
  // First load fails, then the Retry re-fetch succeeds.
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(failure(500, "server_error"))
    .mockResolvedValueOnce({ ok: true, json: async () => SAMPLE });

  render(<OfficerDashboardPage />);
  const retry = await screen.findByRole("button", { name: /retry/i });
  expect(global.fetch).toHaveBeenCalledTimes(1);

  fireEvent.click(retry);

  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
