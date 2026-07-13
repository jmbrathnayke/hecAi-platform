import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminCasesPage from "../page";
import { fetchAdminCases, UNAUTHORIZED } from "@/lib/adminCases";
import { getAccessToken } from "@/lib/auth";

const mockReplace = jest.fn();
const mockPush = jest.fn();
// A mutable, re-assignable search string so tests can simulate "the URL already changed"
// by updating this and calling `rerender()` — a bare `() => new URLSearchParams(x)` mock
// would work for a single render but can't reflect router.push() calls back into the
// component the way the real Next.js router does.
let currentSearch = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a), push: (...a: unknown[]) => mockPush(...a) }),
  useSearchParams: () => new URLSearchParams(currentSearch),
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
jest.mock("@/lib/adminCases", () => ({ fetchAdminCases: jest.fn(), UNAUTHORIZED: "unauthorized" }));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchAdminCases = fetchAdminCases as jest.Mock;

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    canonical_id: "HEC-2026-0001",
    offline_id: "off-1",
    damage_category: "crop",
    status: "Submitted",
    submitted_at: "2026-07-08T10:00:00.000Z",
    updated_at: "2026-07-08T10:00:00.000Z",
    ai_confidence: null,
    ...overrides,
  };
}

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    total: 1,
    page: 1,
    limit: 20,
    items: [makeItem()],
    kpis: {
      this_month: 1,
      by_status: { Submitted: 1 },
      total_approved_lkr: 0,
      avg_processing_days: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  currentSearch = "";
  mockGetUser.mockReset();
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockFetchAdminCases.mockReset().mockResolvedValue(makeResponse());
});

// --- role gate (Story 5.1, must survive the Story 5.3 rewrite unchanged) ----------------

test("a non-admin (e.g. Google OAuth officer/citizen) is signed out and redirected to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "officer" } } }, error: null });
  render(<AdminCasesPage />);

  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledWith("/admin/login");
  expect(mockFetchAdminCases).not.toHaveBeenCalled();
});

test("no role metadata at all is refused and redirected", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null });
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("getUser() error fails closed — redirected, not rendered", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid session" } });
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a thrown network failure during getUser() fails closed — redirected", async () => {
  mockGetUser.mockRejectedValue(new Error("network down"));
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a signOut() failure still redirects (fails closed, never strands a non-admin on the page)", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "citizen" } } }, error: null });
  mockSignOut.mockRejectedValue(new Error("network down"));
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("unmounting before getUser() resolves does not throw or update state", async () => {
  let resolveGetUser: (value: unknown) => void = () => {};
  mockGetUser.mockReturnValue(
    new Promise((resolve) => {
      resolveGetUser = resolve;
    }),
  );
  const { unmount } = render(<AdminCasesPage />);
  unmount();
  resolveGetUser({ data: { user: { user_metadata: { role: "admin" } } }, error: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(mockReplace).not.toHaveBeenCalled();
});

// --- real case list (Story 5.3) ----------------------------------------------------------

function mockAdmin() {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "admin" } } }, error: null });
}

test("an admin sees the real fetched case list, not placeholder text", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(screen.queryByText(/case list coming in story 5\.3/i)).not.toBeInTheDocument();
});

test("no NIC or citizen-identifying text appears anywhere in the rendered list", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ items: [makeItem({ canonical_id: "HEC-2026-0002" })] }),
  );
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0002");
  expect(screen.queryByText(/200012345678/)).not.toBeInTheDocument();
});

test("fetches with the admin's access token and default sort/pagination params", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockFetchAdminCases).toHaveBeenCalledTimes(1));
  const [token, params] = mockFetchAdminCases.mock.calls[0];
  expect(token).toBe("tok-123");
  expect(params).toMatchObject({ page: 1, limit: 20, sort: "submitted_at", dir: "desc" });
});

test("shows a KPI skeleton while loading, then real KPI values once fetched", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ kpis: { this_month: 5, by_status: { Submitted: 3, Approved: 2 }, total_approved_lkr: 150000, avg_processing_days: 2.5 } }),
  );
  render(<AdminCasesPage />);
  await screen.findByTestId("kpi-skeleton");
  await waitFor(() => expect(screen.queryByTestId("kpi-skeleton")).not.toBeInTheDocument());
  expect(screen.getByText("Cases This Month").nextSibling).toHaveTextContent("5");
  expect(screen.getByText(/Rs\. 150,000/)).toBeInTheDocument();
});

test("shows an error state with Retry when the fetch fails, not a blank page", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(null);
  render(<AdminCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.?t load cases/i);
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("Retry re-fetches after a failure", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValueOnce(null).mockResolvedValueOnce(makeResponse());
  render(<AdminCasesPage />);
  await screen.findByRole("alert");
  screen.getByRole("button", { name: /retry/i }).click();
  await waitFor(() => expect(mockFetchAdminCases).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
});

test("clicking a column header sorts ascending on first click", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /sort by canonical id/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases?sort=canonical_id&dir=asc");
});

test("clicking the same column a third time resets to the default sort (AC3)", async () => {
  mockAdmin();
  currentSearch = "sort=canonical_id&dir=desc"; // simulate: already past click 1 (asc) and 2 (desc)
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /sort by canonical id/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases");
});

test("applying a filter pushes it into the URL query string and resets to page 1", async () => {
  mockAdmin();
  currentSearch = "page=3";
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  const statusSelect = screen.getByLabelText("Status") as HTMLSelectElement;
  statusSelect.value = "Approved";
  statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
  screen.getByRole("button", { name: /apply filters/i }).click();
  expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("status=Approved"));
  expect(mockPush).toHaveBeenCalledWith(expect.not.stringContaining("page="));
});

test("Clear Filters navigates back to the bare /admin/cases URL", async () => {
  mockAdmin();
  currentSearch = "status=Approved&page=2";
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /clear filters/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases");
});

test("pagination controls render when there are more results than one page", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ total: 45, page: 1, limit: 20 }));
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^next$/i })).not.toBeDisabled();
});

test("pagination controls do not render for a single page of results", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ total: 1 }));
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.queryByLabelText(/case list pagination/i)).not.toBeInTheDocument();
});

test("selecting a case shows the Story 5.4 detail seam, not a crash", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByText("HEC-2026-0001").closest("tr")!.click();
  // Rendered once per responsive breakpoint (desktop pane + mobile pane); jsdom applies no
  // real CSS media queries, so both exist in the DOM simultaneously in this test — assert
  // at least one, not exactly one.
  const matches = await screen.findAllByText(/coming in story 5\.4/i);
  expect(matches.length).toBeGreaterThanOrEqual(1);
});

test("no results for the current filters shows an empty-state message, not an error", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ items: [], total: 0 }));
  render(<AdminCasesPage />);
  expect(await screen.findByText(/no cases match your current filters/i)).toBeInTheDocument();
});

// --- code review fixes -------------------------------------------------------------------

test("clicking Submission Date on a fresh page load sorts ascending, not a no-op (AC3 code review fix)", async () => {
  // Regression guard for the exact bug the review caught: sortCol defaulted to
  // "submitted_at" even with no explicit URL param, making the default column
  // indistinguishable from "already cycled back to default" on its very first click.
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /sort by submission date/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases?sort=submitted_at&dir=asc");
});

test("an invalid bookmarked sort param falls back to submitted_at, matching the backend's whitelist (code review fix)", async () => {
  mockAdmin();
  currentSearch = "sort=district"; // not in ALLOWED_SORT
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockFetchAdminCases).toHaveBeenCalledTimes(1));
  const [, params] = mockFetchAdminCases.mock.calls[0];
  expect(params).toMatchObject({ sort: "submitted_at" });
});

test("a 401/403 from fetchAdminCases redirects to re-authenticate instead of a dead-end Retry (code review fix)", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(UNAUTHORIZED);
  render(<AdminCasesPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("selecting a case then changing filters clears the stale Story 5.4 selection (code review fix)", async () => {
  mockAdmin();
  const { rerender } = render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByText("HEC-2026-0001").closest("tr")!.click();
  expect((await screen.findAllByText(/coming in story 5\.4/i)).length).toBeGreaterThanOrEqual(1);

  currentSearch = "status=Approved"; // simulate a filter having been applied
  rerender(<AdminCasesPage />);
  await waitFor(() => expect(screen.queryByText(/coming in story 5\.4/i)).not.toBeInTheDocument());
  expect(screen.getAllByText(/select a case to view details/i).length).toBeGreaterThanOrEqual(1);
});

test("a case row is keyboard-selectable via Enter, not mouse-only (code review fix)", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  const row = (await screen.findByText("HEC-2026-0001")).closest("tr")!;
  fireEvent.keyDown(row, { key: "Enter" });
  expect((await screen.findAllByText(/coming in story 5\.4/i)).length).toBeGreaterThanOrEqual(1);
});

test("Days Pending shows — for a case that has left Submitted, not a stale day count (code review fix)", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({
      items: [
        makeItem({
          canonical_id: "HEC-2026-0009",
          status: "Approved",
          submitted_at: "2020-01-01T00:00:00.000Z",
        }),
      ],
    }),
  );
  render(<AdminCasesPage />);
  const row = (await screen.findByText("HEC-2026-0009")).closest("tr") as HTMLTableRowElement;
  // Column order: canonical_id, damage_category, ai_confidence, status, submitted_at,
  // days_pending — the last cell is the one under test.
  expect(row.cells[row.cells.length - 1]).toHaveTextContent("—");
});

test("FilterBar visibly resets after Clear Filters, not just the URL (code review fix)", async () => {
  mockAdmin();
  currentSearch = "status=Approved";
  const { rerender } = render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Approved");

  currentSearch = ""; // simulate router.push("/admin/cases") having navigated
  rerender(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("");
});
