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
  expect(screen.getByText("crop")).toBeInTheDocument();
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(url)).toContain("/api/v1/citizen/cases");
  expect(init.headers.Authorization).toBe("Bearer tok-123");
});

test("shows the empty state when the citizen owns no cases", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ cases: [] }) });
  render(<MyCasesPage />);
  expect(await screen.findByText("empty")).toBeInTheDocument();
});

test("shows an error state when the request fails", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  render(<MyCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("error");
});

test("shows an error state when there is no session token (does not fetch)", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<MyCasesPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(global.fetch).not.toHaveBeenCalled();
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
