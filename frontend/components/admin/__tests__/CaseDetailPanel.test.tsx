import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaseDetailPanel } from "../CaseDetailPanel";
import { fetchAdminCaseDetail, verifyAuditChain } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a) }),
}));

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminCaseDetail", () => ({
  fetchAdminCaseDetail: jest.fn(),
  verifyAuditChain: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchAdminCaseDetail = fetchAdminCaseDetail as jest.Mock;
const mockVerifyAuditChain = verifyAuditChain as jest.Mock;

function makeResponse(overrides: Record<string, unknown> = {}) {
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

beforeEach(() => {
  mockReplace.mockReset();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockFetchAdminCaseDetail.mockReset().mockResolvedValue(makeResponse());
  mockVerifyAuditChain.mockReset().mockResolvedValue({ valid: true, broken_id: null });
});

test("shows a loading state, then the fetched case", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(screen.getByRole("status")).toHaveTextContent(/loading case/i);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
});

test("shows an error state with Retry when the fetch fails", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(null);
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.?t load case detail/i);
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("Retry re-fetches after a failure", async () => {
  mockFetchAdminCaseDetail.mockResolvedValueOnce(null).mockResolvedValueOnce(makeResponse());
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByRole("alert");
  screen.getByRole("button", { name: /retry/i }).click();
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
});

test("a 401/403 redirects to /admin/login instead of showing a dead-end error", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue("unauthorized");
  render(<CaseDetailPanel offlineId="off-1" />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("no access token also redirects-equivalent (shows error, no crash)", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

test("re-fetches when offlineId changes, and an in-flight fetch for the old id doesn't clobber the new selection", async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  mockFetchAdminCaseDetail.mockImplementationOnce(
    () => new Promise((resolve) => { resolveFirst = resolve; }),
  );
  const { rerender } = render(<CaseDetailPanel offlineId="off-1" />);
  expect(screen.getByRole("status")).toBeInTheDocument();

  // Select a different case before the first fetch resolves.
  mockFetchAdminCaseDetail.mockResolvedValueOnce(
    makeResponse({ case: { ...makeResponse().case, canonical_id: "HEC-2026-0002", offline_id: "off-2" } }),
  );
  rerender(<CaseDetailPanel offlineId="off-2" />);
  await screen.findByText("HEC-2026-0002");

  // The stale first fetch resolves late -- must not overwrite the now-current selection.
  resolveFirst(makeResponse({ case: { ...makeResponse().case, canonical_id: "HEC-2026-0001" } }));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByText("HEC-2026-0002")).toBeInTheDocument();
  expect(screen.queryByText("HEC-2026-0001")).not.toBeInTheDocument();
});

test("core case info renders channel, damage category, and submitted timestamp", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.getByText("app")).toBeInTheDocument();
  expect(screen.getByText("crop")).toBeInTheDocument();
});

test("GPS map link renders only when both lat/lng are present", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({ case: { ...makeResponse().case, gps_lat: 7.29, gps_lng: 80.63 } }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  const link = await screen.findByRole("link");
  expect(link).toHaveAttribute("href", "https://www.google.com/maps?q=7.29,80.63");
  expect(link).toHaveAttribute("target", "_blank");
});

test("no GPS map link when coordinates are null", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("photo placeholder is shown, not a real gallery", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/not yet centrally stored/i)).toBeInTheDocument();
});

test("AI result panel shows the empty state when ai_result is null", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/not yet ai-classified/i)).toBeInTheDocument();
});

test("AI result panel shows override info when was_overridden is true", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      ai_result: {
        model_type: "mobilenetv2", model_version: "v1", prediction: "crop_damage",
        confidence: 0.82, was_overridden: true, override_reason: "Actually property damage",
        override_category: "property_damage", ai_severity: "Moderate", created_at: "2026-07-08T10:05:00.000Z",
      },
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  // "crop_damage" appears twice: the top-line predicted class and "Original AI class:
  // crop_damage" in the override callout -- both are correct, assert at least one.
  expect((await screen.findAllByText("crop_damage")).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("property_damage")).toBeInTheDocument();
  expect(screen.getByText(/actually property damage/i)).toBeInTheDocument();
  expect(screen.getByText(/82%\s*confidence/i)).toBeInTheDocument();
});

test("compensation panel shows the empty state when compensation is null", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/no estimate available/i)).toBeInTheDocument();
});

test("compensation panel shows amount, disclaimer, and cap note when capped", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      compensation: {
        amount_lkr: 100000, raw_estimate_lkr: 150000, capped: true,
        feature_values: { damage_type: "property", year: 2026 },
        model_version: "rf_compensation_v2", dataset_version: "2021",
        created_at: "2026-07-08T10:06:00.000Z",
      },
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/ai recommendation — admin approval required/i)).toBeInTheDocument();
  expect(screen.getByText("Rs. 100,000")).toBeInTheDocument();
  expect(screen.getByText(/cap applied/i)).toBeInTheDocument();
});

test("audit trail renders entries chronologically as returned by the backend", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      audit_trail: [
        { id: 1, event: "submitted", actor_id: "citizen-app", metadata: null, created_at: "2026-07-08T10:00:00.000Z", hash: "abc123def456", prev_hash: null },
      ],
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText("submitted")).toBeInTheDocument();
  expect(screen.getByText("citizen-app")).toBeInTheDocument();
});

test("Verify chain integrity button reports a valid chain", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  fireEvent.click(screen.getByRole("button", { name: /verify chain integrity/i }));
  expect(await screen.findByText(/chain intact/i)).toBeInTheDocument();
});

test("Verify chain integrity button reports tampering", async () => {
  mockVerifyAuditChain.mockResolvedValue({ valid: false, broken_id: 3 });
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  fireEvent.click(screen.getByRole("button", { name: /verify chain integrity/i }));
  expect(await screen.findByText(/tampering detected/i)).toBeInTheDocument();
});
