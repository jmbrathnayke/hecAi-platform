import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MyCasesPage from "../page";

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const mockGetAccessToken = jest.fn();
jest.mock("@/lib/auth", () => ({
  getAccessToken: () => mockGetAccessToken(),
}));

jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: jest.fn().mockResolvedValue({}) } }),
}));

const SAMPLE = {
  cases: [
    {
      canonical_id: "HEC-2026-0001",
      offline_id: "uuid-1",
      status: "Submitted",
      damage_category: "crop",
      submitted_via: "app",
      submitted_at: "2026-07-08T09:00:00.000Z",
      updated_at: "2026-07-08T09:00:00.000Z",
    },
  ],
  count: 1,
};

beforeEach(() => {
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE }) as unknown as typeof fetch;
});

test("renders the citizen's cases and sends the Bearer token", async () => {
  render(<MyCasesPage />);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  // Through the translator, not as the raw column value. Both of these used to render the English
  // database string to a Sinhala or Tamil reader — "crop" and "Submitted" — even though every
  // label has been translated in all three message files since Story 2.5.
  expect(screen.getByText("category.crop")).toBeInTheDocument();
  expect(screen.getByText("statusLabels.Submitted")).toBeInTheDocument();
  expect(screen.queryByText("crop")).not.toBeInTheDocument();
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(url)).toContain("/api/v1/citizen/cases");
  expect(init.headers.Authorization).toBe("Bearer tok-123");
});

test("shows the empty state when the citizen owns no cases", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ cases: [] }) });
  render(<MyCasesPage />);
  expect(await screen.findByText("empty")).toBeInTheDocument();
});

test("a server fault says so, and offers Retry", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  render(<MyCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("serverTitle");
  expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  // Nothing is wrong with their account, so do not send them to a login screen.
  expect(screen.queryByRole("link", { name: "signIn" })).not.toBeInTheDocument();
});

test("a network failure is told apart from a server fault", async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
  render(<MyCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("networkTitle");
  expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
});

test("no session asks the citizen to sign in and does NOT offer Retry", async () => {
  // The defect this guards. Retry cannot produce a session, so offering it left a signed-out
  // citizen pressing a button that failed every time while being told the system was broken.
  mockGetAccessToken.mockResolvedValue(null);
  render(<MyCasesPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByRole("alert")).toHaveTextContent("signedOutTitle");
  expect(screen.getByRole("link", { name: "signIn" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "retry" })).not.toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("an expired session is told apart from never having signed in", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
  render(<MyCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("expiredTitle");
  expect(screen.getByRole("link", { name: "signIn" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "retry" })).not.toBeInTheDocument();
});

test("Sign out is not offered to someone who is not signed in", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<MyCasesPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "signOut" })).not.toBeInTheDocument();
});

test("the reference lookup stays reachable when sign-in is the obstacle", async () => {
  // FR-6.1: a reference number needs no account, so the one route that still works must be on the
  // screen that tells someone they cannot sign in.
  mockGetAccessToken.mockResolvedValue(null);
  render(<MyCasesPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "checkByReference" })).toBeInTheDocument();
});

test("Retry re-fetches after an error and recovers", async () => {
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, json: async () => SAMPLE });

  render(<MyCasesPage />);
  const retry = await screen.findByRole("button", { name: "retry" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
