import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DsDashboardPage from "@/app/ds/dashboard/page";
import { fetchDsCases } from "@/lib/dsCases";
import { fetchCaseClaimant } from "@/lib/caseClaimant";

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
jest.mock("@/lib/dsCases", () => ({ fetchDsCases: jest.fn() }));
// The evidence panel renders the gallery, which fetches on its own; these tests are about the card.
jest.mock("@/lib/casePhotos", () => ({ listCasePhotos: jest.fn().mockResolvedValue({ ok: true, photos: [] }) }));
jest.mock("@/lib/caseClaimant", () => ({ fetchCaseClaimant: jest.fn() }));

const mockFetch = fetchDsCases as jest.Mock;

const THALAWA = "තලාව";

const CLAIMANT = {
  household_ref: "HH-2026-0001", district: "අනුරාධපුරය", ds_division: "තලාව", gn_division: null,
  status: "active", registered_at: "2026-09-01T00:00:00Z", address: "12, Temple Road",
  contact_email: null, contact_mobile: "+94771234567",
  members: [{ full_name: "K. M. Perera", relationship: null, is_registrant: true }],
};

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

const mockClaimant = fetchCaseClaimant as jest.Mock;

beforeEach(() => {
  mockClaimant.mockReset().mockResolvedValue({ ok: true, household: CLAIMANT });
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
  // The filter labels are translated now (redesign 2026-10-07; they were raw English in every
  // language), so the mock translator shows each as its message key.
  it("refetches with the chosen status", async () => {
    render(<DsDashboardPage />);
    await screen.findByText(THALAWA);
    fireEvent.click(screen.getByRole("button", { name: "statusLabels.Approved" }));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith("Approved"));
  });

  it("clears the filter back to undefined, not an empty string", async () => {
    render(<DsDashboardPage />);
    await screen.findByText(THALAWA);
    fireEvent.click(screen.getByRole("button", { name: "statusLabels.Approved" }));
    fireEvent.click(screen.getByRole("button", { name: "filterAll" }));
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

describe("the evidence a payment is decided on (migration 040)", () => {
  it("shows what the family wrote beside their photographs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      cases: [dsCase("HEC-2026-0001", { citizen_description: "අලියා ගෙදර බිත්තිය කැඩුවා" })],
      count: 1,
      dsDivision: THALAWA,
    });
    render(<DsDashboardPage />);
    fireEvent.click(await screen.findByTestId("ds-evidence-toggle"));
    expect(await screen.findByTestId("ds-citizen-description")).toHaveTextContent("අලියා ගෙදර බිත්තිය කැඩුවා");
  });

  it("says so when the family wrote nothing", async () => {
    mockFetch.mockResolvedValue({ ok: true, cases: [dsCase("HEC-2026-0001")], count: 1, dsDivision: THALAWA });
    render(<DsDashboardPage />);
    fireEvent.click(await screen.findByTestId("ds-evidence-toggle"));
    expect(await screen.findByTestId("ds-citizen-description")).toHaveTextContent("evidence.noDescription");
  });
});

describe("who the claim belongs to (2026-10-07)", () => {
  it("shows the damage type and the date reported on the card itself", async () => {
    mockFetch.mockResolvedValue({ ok: true, cases: [dsCase("HEC-2026-0001")], count: 1, dsDivision: THALAWA });
    render(<DsDashboardPage />);
    const line = await screen.findByTestId("ds-case-incident");
    expect(line).toHaveTextContent("crop");
    expect(line).toHaveTextContent("submittedOn");
  });

  it("loads the family's details only when the officer opens that case's evidence", async () => {
    mockFetch.mockResolvedValue({ ok: true, cases: [dsCase("HEC-2026-0001"), dsCase("HEC-2026-0002")], count: 2, dsDivision: THALAWA });
    render(<DsDashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId("ds-case")).toHaveLength(2));
    // The list itself never fetches anyone's details.
    expect(mockClaimant).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTestId("ds-evidence-toggle")[0]);
    expect(await screen.findByTestId("claimant-name")).toHaveTextContent("K. M. Perera");
    expect(mockClaimant).toHaveBeenCalledTimes(1);
    expect(mockClaimant).toHaveBeenCalledWith("HEC-2026-0001");
  });

  it("does not ask for a family when the case has no household", async () => {
    mockFetch.mockResolvedValue({
      ok: true, cases: [dsCase("HEC-2025-0009", { household_ref: null })], count: 1, dsDivision: THALAWA,
    });
    render(<DsDashboardPage />);
    fireEvent.click(await screen.findByTestId("ds-evidence-toggle"));
    await screen.findByTestId("ds-citizen-description");
    expect(screen.queryByTestId("claimant-details")).not.toBeInTheDocument();
    expect(mockClaimant).not.toHaveBeenCalled();
  });
});

describe("the work queue (redesign 2026-10-07)", () => {
  it("counts what needs a decision, what is ready to pay and what is with the DWC", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      cases: [
        dsCase("HEC-2026-0001", { status: "Approved", final_decision: null, payment_authorized: false }),
        dsCase("HEC-2026-0002", { status: "Approved", final_decision: { amount_lkr: 1, reason: null, decided_at: null }, payment_authorized: false }),
        dsCase("HEC-2026-0003"),
        dsCase("HEC-2026-0004", { status: "Rejected" }),
      ],
      count: 4,
      dsDivision: THALAWA,
    });
    render(<DsDashboardPage />);
    // Each cell is label then count in the DOM (the count is shown on top only visually).
    const queue = await screen.findByTestId("ds-queue");
    expect(queue).toHaveTextContent("queue.decide1");
    expect(queue).toHaveTextContent("queue.pay1");
    expect(queue).toHaveTextContent("queue.waiting1");
    expect(queue).toHaveTextContent("queue.paid0");
    // Each card says what this office does next; a rejected claim has nothing next.
    expect(screen.getAllByTestId("ds-next-step").map((n) => n.textContent)).toEqual([
      "queue.decide", "queue.pay", "queue.waiting",
    ]);
  });

  it("is not shown under a status filter, where it would count only a subset", async () => {
    render(<DsDashboardPage />);
    await screen.findByTestId("ds-queue");
    fireEvent.click(screen.getByRole("button", { name: "statusLabels.Submitted" }));
    await waitFor(() => expect(screen.queryByTestId("ds-queue")).not.toBeInTheDocument());
  });
});
