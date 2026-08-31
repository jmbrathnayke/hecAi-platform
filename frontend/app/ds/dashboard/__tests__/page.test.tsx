import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DsDashboardPage from "@/app/ds/dashboard/page";
import { fetchDsCases } from "@/lib/dsCases";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
jest.mock("@/lib/dsCases", () => ({ fetchDsCases: jest.fn() }));

const mockFetch = fetchDsCases as jest.Mock;

const THALAWA = "තලාව";

function dsCase(id: string, over: Record<string, unknown> = {}) {
  return {
    canonical_id: id,
    offline_id: `uuid-${id}`,
    status: "Submitted",
    damage_category: "crop",
    submitted_via: "app",
    submitted_at: "2026-08-20T09:00:00",
    updated_at: "2026-08-20T09:00:00",
    approved_amount: null,
    household_ref: "HH-2026-0001",
    ...over,
  };
}

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    cases: [dsCase("HEC-2026-0001"), dsCase("HEC-2026-0002")],
    count: 2,
    dsDivision: THALAWA,
  });
});

describe("the division is always visible", () => {
  it("names the officer's division in the header", async () => {
    render(<DsDashboardPage />);
    expect(await screen.findByText(THALAWA)).toBeInTheDocument();
  });

  it("lists the division's cases with their household reference", async () => {
    render(<DsDashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId("ds-case")).toHaveLength(2));
    expect(screen.getByText("HEC-2026-0001")).toBeInTheDocument();
    expect(screen.getAllByText(/HH-2026-0001/)[0]).toBeInTheDocument();
  });

  it("says so when a case predates the registry rather than showing an empty field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      cases: [dsCase("HEC-2025-0009", { household_ref: null })],
      count: 1,
      dsDivision: THALAWA,
    });
    render(<DsDashboardPage />);
    expect(await screen.findByText(/noHousehold/)).toBeInTheDocument();
  });

  it("shows an empty state rather than a blank page", async () => {
    mockFetch.mockResolvedValue({ ok: true, cases: [], count: 0, dsDivision: THALAWA });
    render(<DsDashboardPage />);
    expect(await screen.findByText("empty")).toBeInTheDocument();
  });
});

describe("filtering", () => {
  it("refetches with the chosen status", async () => {
    render(<DsDashboardPage />);
    await screen.findByText(THALAWA);
    fireEvent.click(screen.getByText("Approved"));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith("Approved"));
  });

  it("clears the filter back to undefined, not an empty string", async () => {
    render(<DsDashboardPage />);
    await screen.findByText(THALAWA);
    fireEvent.click(screen.getByText("Approved"));
    fireEvent.click(screen.getByText("filterAll"));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(undefined));
  });
});

describe("failures are told apart", () => {
  it("distinguishes 'no division assigned' from 'not a DS officer'", async () => {
    // Both arrive as 403 and mean opposite things: one is an administrator's job to fix, the
    // other means this person should not be here at all.
    mockFetch.mockResolvedValue({
      ok: false,
      failure: { reason: "no-division", status: 403, code: "no_division_assigned" },
    });
    render(<DsDashboardPage />);
    expect(await screen.findByText("error.noDivision")).toBeInTheDocument();
    expect(screen.queryByText("error.forbidden")).not.toBeInTheDocument();
    // Retrying cannot assign a division.
    expect(screen.queryByText("retry")).not.toBeInTheDocument();
  });

  it("reports a wrong-role account as forbidden", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      failure: { reason: "forbidden", status: 403, code: "forbidden" },
    });
    render(<DsDashboardPage />);
    expect(await screen.findByText("error.forbidden")).toBeInTheDocument();
    expect(screen.queryByText("retry")).not.toBeInTheDocument();
  });

  it("offers retry on a network failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, failure: { reason: "network" } });
    render(<DsDashboardPage />);
    expect(await screen.findByText("error.network")).toBeInTheDocument();
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("shows the HTTP status and backend code so nobody needs DevTools", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      failure: { reason: "server", status: 500, code: "server_error" },
    });
    render(<DsDashboardPage />);
    expect(await screen.findByText("error.detail")).toBeInTheDocument();
  });

  it("does not show a status line for a transport failure that has none", async () => {
    mockFetch.mockResolvedValue({ ok: false, failure: { reason: "network" } });
    render(<DsDashboardPage />);
    await screen.findByText("error.network");
    expect(screen.queryByText("error.detail")).not.toBeInTheDocument();
  });
});
