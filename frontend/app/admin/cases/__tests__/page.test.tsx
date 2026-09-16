import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminCasesPage from "../page";
import { fetchAdminCases, UNAUTHORIZED } from "@/lib/adminCases";
import { fetchAdminCaseDetail } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";

// next-intl passthrough (Story 6.3): the translator returns the key, appending interpolation
// values so assertions on interpolated strings (e.g. "cases.pageOf 1 3", "table.sortAria
// table.colCanonicalId") stay legible. Covers the page and the REAL children it renders
// (CaseListTable / FilterBar / AdminKpiCards / CaseDetailPanel), all now localized.
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
// Story 5.4: the seam now mounts a real CaseDetailPanel, which fetches its own data via
// lib/adminCaseDetail — mocked here the same way lib/adminCases already is, so selecting a
// case in these page-level tests doesn't attempt a real, unmocked fetch().
jest.mock("@/lib/adminCaseDetail", () => ({
  fetchAdminCaseDetail: jest.fn(),
  verifyAuditChain: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchAdminCases = fetchAdminCases as jest.Mock;
const mockFetchAdminCaseDetail = fetchAdminCaseDetail as jest.Mock;

function makeDetailResponse(overrides: Record<string, unknown> = {}) {
  return {
    case: {
      canonical_id: "HEC-2026-0001",
      offline_id: "off-1",
      damage_category: "crop",
      status: "Submitted",
      gps_lat: null,
      gps_lng: null,
      submitted_at: "2026-07-08T10:00:00.000Z",
      updated_at: "2026-07-08T10:00:00.000Z",
      submitted_via: "app",
      submitter_identity_hash: "deadbeef",
      approved_amount: null,
    },
    ai_result: null,
    compensation: null,
    audit_trail: [],
    ...overrides,
  };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    canonical_id: "HEC-2026-0001",
    offline_id: "off-1",
    damage_category: "crop",
    status: "Submitted",
    submitted_at: "2026-07-08T10:00:00.000Z",
    updated_at: "2026-07-08T10:00:00.000Z",
    ai_confidence: null,
    // Defaults to the officer-verified case, so a test that cares about the UNVERIFIED state has
    // to say so explicitly rather than inheriting it from a fixture that happens to be falsy.
    submitted_by_officer: true,
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
  mockFetchAdminCaseDetail.mockReset().mockResolvedValue(makeDetailResponse());
});

// --- role gate (Story 5.1, must survive the Story 5.3 rewrite unchanged) ----------------

test("a non-admin (e.g. Google OAuth officer/citizen) is signed out and redirected to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: { role: "officer" } } }, error: null });
  render(<AdminCasesPage />);

  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledWith("/admin/login");
  expect(mockFetchAdminCases).not.toHaveBeenCalled();
});

test("no role metadata at all is refused and redirected", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: {} } }, error: null });
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
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: { role: "citizen" } } }, error: null });
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
  resolveGetUser({ data: { user: { app_metadata: { role: "admin" } } }, error: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(mockReplace).not.toHaveBeenCalled();
});

// --- real case list (Story 5.3) ----------------------------------------------------------

function mockAdmin() {
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: { role: "admin" } } }, error: null });
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
  expect(screen.getByText("kpi.thisMonth").nextSibling).toHaveTextContent("5");
  expect(screen.getByText(/Rs\. 150,000/)).toBeInTheDocument();
});

// A8 (deferred-work triage, 2026-08-17). The KPIs are district-wide and deliberately ignore the
// case list's filters — admin.py runs separate KPI queries, and a test already locks that in. The
// gap was that nothing SAID so, which reads as a broken dashboard: narrow the list, watch every
// number sit still. This asserts the scope note is present once real KPIs render, so a future
// tidy-up can't silently drop the only thing explaining the behaviour.
test("labels the KPI row as district-wide so the ignored filters don't read as a bug", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ kpis: { this_month: 5, by_status: { Submitted: 3 }, total_approved_lkr: 0, avg_processing_days: null } }),
  );
  render(<AdminCasesPage />);
  // findBy, not waitFor(queryBy → absent): the page mounts asynchronously, so an absence
  // assertion passes instantly against an empty DOM and proves nothing.
  const note = await screen.findByTestId("kpi-scope-note");
  expect(note).toHaveTextContent("kpi.scopeNote");
  expect(screen.queryByTestId("kpi-skeleton")).not.toBeInTheDocument();
});

// Code review fix (Story 6.3): `cases.status` has no DB-level CHECK constraint, so a status
// outside the 5 canonical STATUS_VALUES must still render as itself, not next-intl's
// missing-message placeholder ("statusLabels.<key>").
test("a case-list status badge falls back to the raw status string for a non-canonical value", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ items: [makeItem({ status: "Archived" })] }),
  );
  render(<AdminCasesPage />);
  expect(await screen.findByText("Archived")).toBeInTheDocument();
  expect(screen.queryByText(/statusLabels\.Archived/)).not.toBeInTheDocument();
});

test("the KPI 'By Status' breakdown falls back to the raw status string for a non-canonical value", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({
      kpis: { this_month: 1, by_status: { Archived: 1 }, total_approved_lkr: 0, avg_processing_days: null },
    }),
  );
  render(<AdminCasesPage />);
  // The breakdown renders as <dt>label</dt><dd>count</dd> rows (not one joined
  // "Archived: 1" string) so the card stays readable in the mobile 2-col grid -- assert the
  // raw fallback label and its count separately. The point of the test is unchanged: a
  // non-canonical status shows its raw value, never next-intl's missing-message placeholder.
  const term = await screen.findByText("Archived");
  expect(term.tagName).toBe("DT");
  expect(term.nextSibling).toHaveTextContent("1");
  expect(screen.queryByText(/statusLabels\.Archived/)).not.toBeInTheDocument();
});

test("shows an error state with Retry when the fetch fails, not a blank page", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(null);
  render(<AdminCasesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("cases.loadError");
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
  screen.getByRole("button", { name: /table\.sortAria table\.colCanonicalId/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases?sort=canonical_id&dir=asc");
});

test("clicking the same column a third time resets to the default sort (AC3)", async () => {
  mockAdmin();
  currentSearch = "sort=canonical_id&dir=desc"; // simulate: already past click 1 (asc) and 2 (desc)
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /table\.sortAria table\.colCanonicalId/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases");
});

test("applying a filter pushes it into the URL query string and resets to page 1", async () => {
  mockAdmin();
  currentSearch = "page=3";
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  const statusSelect = screen.getByLabelText("filter.status") as HTMLSelectElement;
  statusSelect.value = "Approved";
  statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
  screen.getByRole("button", { name: /filter\.apply/i }).click();
  expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("status=Approved"));
  expect(mockPush).toHaveBeenCalledWith(expect.not.stringContaining("page="));
});

test("Clear Filters navigates back to the bare /admin/cases URL", async () => {
  mockAdmin();
  currentSearch = "status=Approved&page=2";
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /filter\.clear/i }).click();
  expect(mockPush).toHaveBeenCalledWith("/admin/cases");
});

test("pagination controls render when there are more results than one page", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ total: 45, page: 1, limit: 20 }));
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByText("cases.pageOf 1 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /cases\.next/i })).not.toBeDisabled();
});

test("pagination controls do not render for a single page of results", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ total: 1 }));
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.queryByLabelText(/cases\.paginationAria/i)).not.toBeInTheDocument();
});

test("selecting a case shows the real Story 5.4 CaseDetailPanel, not a crash", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByText("HEC-2026-0001").closest("tr")!.click();
  // "Not yet AI-classified" is AIResultPanel's empty state, a marker only the real
  // CaseDetailPanel (not the old placeholder) renders.
  expect(await screen.findByText(/ai\.empty/i)).toBeInTheDocument();
  expect(mockFetchAdminCaseDetail).toHaveBeenCalledWith("tok-123", "off-1");
});

test("selecting a case mounts CaseDetailPanel exactly once, not once per responsive pane (code review fix)", async () => {
  // Regression guard: the seam used to render selectedDetailContent at two separate JSX
  // positions (a desktop `hidden lg:block` wrapper + a mobile `lg:hidden` wrapper). CSS
  // display:none doesn't stop a component from mounting, so both silently mounted their own
  // CaseDetailPanel instance, doubling every fetch and audit-log write per case selection.
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByText("HEC-2026-0001").closest("tr")!.click();
  await screen.findByText(/ai\.empty/i);
  expect(screen.getAllByText(/ai\.empty/i)).toHaveLength(1);
  expect(mockFetchAdminCaseDetail).toHaveBeenCalledTimes(1);
});

test("no results for the current filters shows an empty-state message, not an error", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(makeResponse({ items: [], total: 0 }));
  render(<AdminCasesPage />);
  expect(await screen.findByText("cases.empty")).toBeInTheDocument();
});

// --- code review fixes -------------------------------------------------------------------

test("clicking Submission Date on a fresh page load sorts ascending, not a no-op (AC3 code review fix)", async () => {
  // Regression guard for the exact bug the review caught: sortCol defaulted to
  // "submitted_at" even with no explicit URL param, making the default column
  // indistinguishable from "already cycled back to default" on its very first click.
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  screen.getByRole("button", { name: /table\.sortAria table\.colSubmissionDate/i }).click();
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
  expect((await screen.findAllByText(/ai\.empty/i)).length).toBeGreaterThanOrEqual(1);

  currentSearch = "status=Approved"; // simulate a filter having been applied
  rerender(<AdminCasesPage />);
  await waitFor(() => expect(screen.queryByText(/ai\.empty/i)).not.toBeInTheDocument());
  expect(screen.getAllByText(/cases\.selectPrompt/i).length).toBeGreaterThanOrEqual(1);
});

test("a case row is keyboard-selectable via Enter, not mouse-only (code review fix)", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  const row = (await screen.findByText("HEC-2026-0001")).closest("tr")!;
  fireEvent.keyDown(row, { key: "Enter" });
  expect((await screen.findAllByText(/ai\.empty/i)).length).toBeGreaterThanOrEqual(1);
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
  expect((screen.getByLabelText("filter.status") as HTMLSelectElement).value).toBe("Approved");

  currentSearch = ""; // simulate router.push("/admin/cases") having navigated
  rerender(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect((screen.getByLabelText("filter.status") as HTMLSelectElement).value).toBe("");
});

// --- Story 7.2: ExportButton integration (Task 9) --------------------------------------
// Code review finding: this file was never updated when ExportButton was mounted, so nothing
// asserted that the button appears, receives the live total, or respects the empty/loading
// states Task 7 mandates. The suite stayed green only because the button is inert until
// clicked — which is exactly the kind of coverage gap that ships a broken integration.

test("mounts the export button with the live filtered total", async () => {
  mockAdmin();
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  // The count comes from data.total (the whole filtered set), not the current page length.
  expect(
    screen.getByRole("button", { name: /export\.button/ }),
  ).toBeInTheDocument();
});

test("export button is disabled when the filters match no cases", async () => {
  mockAdmin();
  (fetchAdminCases as jest.Mock).mockResolvedValue({
    total: 0,
    page: 1,
    limit: 20,
    items: [],
    kpis: { this_month: 0, by_status: {}, total_approved_lkr: 0, avg_processing_days: null },
  });
  render(<AdminCasesPage />);
  await screen.findByText("cases.empty");
  expect(screen.getByRole("button", { name: /export\.button/ })).toBeDisabled();
});

test("export button is not offered while the list is still loading", async () => {
  mockAdmin();
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  (fetchAdminCases as jest.Mock).mockReturnValue(pending);

  render(<AdminCasesPage />);
  await screen.findByText("cases.loading");
  expect(screen.getByRole("button", { name: /export\.button/ })).toBeDisabled();

  // Settle with a real payload and wait for the resulting render, so the test doesn't leave an
  // unawaited state update behind (React act() warning) after it returns.
  release({
    total: 1,
    page: 1,
    limit: 20,
    items: [
      {
        canonical_id: "HEC-2026-0001",
        offline_id: "o-1",
        damage_category: "property",
        status: "Submitted",
        submitted_at: "2026-07-05T09:00:00Z",
        updated_at: null,
        ai_confidence: null,
      },
    ],
    kpis: { this_month: 1, by_status: {}, total_approved_lkr: 0, avg_processing_days: null },
  });
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled();
});

// ============================================================ verification column
//
// WHY THIS COLUMN EXISTS. Two claims can reach this list with identical damage, identical amount
// and identical status: one where a DWC officer walked to the site and photographed the damage,
// and one where the citizen uploaded a photo from home and nobody checked anything. Before this
// column the approver could not tell them apart — `submitted_via` reads "app" for both paths
// (migration 009) — so the same money was authorised on the same evidence in both cases. See R-18.

test("a case an officer verified is labelled as verified", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ items: [makeItem({ submitted_by_officer: true })] }),
  );
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByText("table.verifiedByOfficer")).toBeInTheDocument();
  expect(screen.queryByText("table.notVerified")).not.toBeInTheDocument();
});

test("a self-reported case is labelled as NOT verified", async () => {
  mockAdmin();
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ items: [makeItem({ submitted_by_officer: false })] }),
  );
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByText("table.notVerified")).toBeInTheDocument();
});

test("the warning is carried by text, not by colour alone", async () => {
  mockAdmin();
  // An approver with a colour-vision deficiency, or reading a printed case list, must still see
  // that nobody verified the claim. WCAG 1.4.1: colour is never the only carrier of meaning.
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({ items: [makeItem({ submitted_by_officer: false })] }),
  );
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0001");
  const badge = screen.getByText("table.notVerified");
  expect(badge.textContent).toBeTruthy();
});

test("verified and unverified cases are distinguishable in one list", async () => {
  mockAdmin();
  // The realistic case: a district's queue holds both, and the difference must be visible while
  // scanning rather than only after opening each one.
  mockFetchAdminCases.mockResolvedValue(
    makeResponse({
      items: [
        makeItem({ canonical_id: "HEC-2026-0001", offline_id: "off-1", submitted_by_officer: true }),
        makeItem({ canonical_id: "HEC-2026-0002", offline_id: "off-2", submitted_by_officer: false }),
      ],
    }),
  );
  render(<AdminCasesPage />);
  await screen.findByText("HEC-2026-0002");
  expect(screen.getByText("table.verifiedByOfficer")).toBeInTheDocument();
  expect(screen.getByText("table.notVerified")).toBeInTheDocument();
});
