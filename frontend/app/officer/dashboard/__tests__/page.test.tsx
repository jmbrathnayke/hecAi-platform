import { render, screen, waitFor } from "@testing-library/react";
import OfficerDashboardPage from "../page";

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

beforeEach(() => {
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => SAMPLE,
  }) as unknown as typeof fetch;
});

test("renders the officer's cases and sends the Bearer token", async () => {
  render(<OfficerDashboardPage />);

  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(screen.getByText("crop")).toBeInTheDocument();
  expect(screen.getByText(/via app/)).toBeInTheDocument();

  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers.Authorization).toBe("Bearer tok-123");
});

test("shows the empty state when the officer has no cases", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ cases: [] }) });
  render(<OfficerDashboardPage />);
  expect(await screen.findByText(/no cases in your scope yet/i)).toBeInTheDocument();
});

test("shows an error state when the request fails", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  render(<OfficerDashboardPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load your cases/i);
});

test("shows an error state when there is no session token (does not fetch)", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<OfficerDashboardPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(global.fetch).not.toHaveBeenCalled();
});
