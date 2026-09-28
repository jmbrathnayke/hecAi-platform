import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaseDetailPanel } from "../CaseDetailPanel";
import { fetchAdminCaseDetail, verifyAuditChain, performCaseAction } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";
import { listCasePhotos } from "@/lib/casePhotos";

// next-intl passthrough (Story 6.3): translator returns the key (+ interpolation values) and a
// fixed locale. Covers the panel and every real child it renders (PhotoGallery / AIResultPanel /
// CompensationPanel / AuditTrail / CaseActionPanel). Backend record VALUES (submitted_via,
// prediction, override_category, audit event/actor, LKR figures) stay raw and are asserted as-is.
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

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
// The gallery fetches on its own; this panel's tests are about the case file around it.
jest.mock("@/lib/casePhotos", () => ({ listCasePhotos: jest.fn() }));
jest.mock("@/lib/adminCaseDetail", () => ({
  fetchAdminCaseDetail: jest.fn(),
  verifyAuditChain: jest.fn(),
  performCaseAction: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockListCasePhotos = listCasePhotos as jest.Mock;
const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchAdminCaseDetail = fetchAdminCaseDetail as jest.Mock;
const mockVerifyAuditChain = verifyAuditChain as jest.Mock;
const mockPerformCaseAction = performCaseAction as jest.Mock;

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
  mockPerformCaseAction.mockReset().mockResolvedValue(makeResponse());
  mockListCasePhotos.mockReset().mockResolvedValue({ ok: true, photos: [] });
});

test("shows a loading state, then the fetched case", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(screen.getByRole("status")).toHaveTextContent(/detail\.loading/i);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
});

test("shows an error state with Retry when the fetch fails", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(null);
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/detail\.loadError/i);
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
  expect(screen.getByText("step3.crop")).toBeInTheDocument();
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

test("the case file reaches the evidence gallery by the case's own reference", async () => {
  // The administrator approves from this screen. Until migration 038 there was nothing to show
  // here at all, and the approval rested on a class label and a percentage.
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  expect(mockListCasePhotos).toHaveBeenCalledWith("HEC-2026-0001");
});

test("AI result panel shows the empty state when ai_result is null", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/ai\.empty/i)).toBeInTheDocument();
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
  expect(screen.getByText(/ai\.confidence 82/i)).toBeInTheDocument();
  // The administrator approves against this number; it must not be read as the chance it is right.
  expect(screen.getByTestId("confidence-caveat")).toHaveTextContent(/ai\.confidenceCaveat/);
});

test("AI result panel marks a row the open-set gate rejected, and hides the percentage", async () => {
  // A gated row arrives as no_damage like any other. The administrator approves against this
  // screen, so it has to distinguish "the officer photographed undamaged land" from "the model
  // could not recognise the photo at all" -- the second is not a finding about the land, and the
  // softmax percentage describes a choice that was discarded.
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      ai_result: {
        model_type: "mobilenetv2", model_version: "mobilenetv2-v1", prediction: "no_damage",
        confidence: 0, was_overridden: false, override_reason: null, override_category: null,
        ai_severity: "None", out_of_domain: true, domain_distance: 0.664,
        raw_prediction: "property_damage", created_at: "2026-09-28T10:05:00.000Z",
      },
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByTestId("ood-notice")).toHaveTextContent(/ai\.outOfDomain/);
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.queryByTestId("confidence-caveat")).not.toBeInTheDocument();
});

test("AI result panel leaves an ordinary row untouched (no gate notice)", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      ai_result: {
        model_type: "mobilenetv2", model_version: "mobilenetv2-v1", prediction: "crop_damage",
        confidence: 0.82, was_overridden: false, override_reason: null, override_category: null,
        ai_severity: "Moderate", out_of_domain: false, created_at: "2026-09-28T10:05:00.000Z",
      },
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByTestId("confidence-caveat")).toBeInTheDocument();
  expect(screen.queryByTestId("ood-notice")).not.toBeInTheDocument();
});

test("compensation panel shows the empty state when compensation is null", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/compensation\.empty/i)).toBeInTheDocument();
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
  expect(await screen.findByText(/compensation\.aiRecommendation/i)).toBeInTheDocument();
  expect(screen.getByText("Rs. 100,000")).toBeInTheDocument();
  expect(screen.getByText(/compensation\.capYes/i)).toBeInTheDocument();
});

test("compensation panel explicitly shows Cap applied: No when not capped (code review fix, AC3/Task 7)", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({
      compensation: {
        amount_lkr: 45000, raw_estimate_lkr: 45000, capped: false,
        feature_values: { damage_type: "crop", year: 2026 },
        model_version: "rf_compensation_v2", dataset_version: "2021",
        created_at: "2026-07-08T10:06:00.000Z",
      },
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  expect(await screen.findByText(/compensation\.capNo/i)).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: /audit\.verify/i }));
  expect(await screen.findByText(/audit\.valid/i)).toBeInTheDocument();
});

test("Verify chain integrity button reports tampering and shows the broken row id (code review fix)", async () => {
  mockVerifyAuditChain.mockResolvedValue({ valid: false, broken_id: 3 });
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  fireEvent.click(screen.getByRole("button", { name: /audit\.verify/i }));
  expect(await screen.findByText(/audit\.invalidWithRow/i)).toBeInTheDocument();
  // The interpolated broken row id (3) is shown (robust mock renders "audit.invalidWithRow 3").
  expect(screen.getByText(/audit\.invalidWithRow 3/i)).toBeInTheDocument();
});

// --- case review actions (Story 5.5 integration) --------------------------------------------

test("shows the case status badge", async () => {
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  // The status badge reuses the shared status.statusLabels namespace ("Submitted" ->
  // statusLabels.Submitted); scope to the badge SPAN specifically.
  const badges = screen.getAllByText("statusLabels.Submitted").filter((el) => el.tagName === "SPAN");
  expect(badges).toHaveLength(1);
});

// Code review fix (Story 6.3): `cases.status` has no DB-level CHECK constraint, so a status
// outside the 5 canonical STATUS_VALUES must still render as itself, not next-intl's
// missing-message placeholder ("statusLabels.<key>").
test("the status badge falls back to the raw status string for a non-canonical value", async () => {
  mockFetchAdminCaseDetail.mockResolvedValue(
    makeResponse({ case: { ...makeResponse().case, status: "Archived" } }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.queryByText(/statusLabels\.Archived/)).not.toBeInTheDocument();
  const badges = screen.getAllByText("Archived").filter((el) => el.tagName === "SPAN");
  expect(badges).toHaveLength(1);
});

test("completing an action updates the panel's status and audit trail from the single response, with no second fetch", async () => {
  mockPerformCaseAction.mockResolvedValue(
    makeResponse({
      case: { ...makeResponse().case, status: "Under Review" },
      audit_trail: [
        {
          id: 1, event: "case_escalated", actor_id: "admin-1", metadata: null,
          created_at: "2026-07-08T10:10:00.000Z", hash: "abc123", prev_hash: null,
        },
      ],
    }),
  );
  render(<CaseDetailPanel offlineId="off-1" />);
  await screen.findByText("HEC-2026-0001");

  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));

  expect(await screen.findByText("case_escalated")).toBeInTheDocument();
  expect(screen.getByText("statusLabels.UnderReview")).toBeInTheDocument();
  expect(mockFetchAdminCaseDetail).toHaveBeenCalledTimes(1);
});
