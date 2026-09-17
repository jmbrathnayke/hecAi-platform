/**
 * Officer case review page (final governance workflow): where a "new report in your division"
 * notification lands. The officer classifies THEIR OWN photo on-device and submits only the result;
 * the compensation figure is shown as an AI-assisted estimate, never as a decision.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficerCaseReviewPage from "@/app/officer/cases/[ref]/page";
import {
  getOfficerCase,
  startOfficerReview,
  submitOfficerAssessment,
} from "@/lib/officerCaseReview";
import { classifyImage } from "@/lib/mobilenet";

jest.mock("next/navigation", () => ({ useParams: () => ({ ref: "hec-2026-0001" }) }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));
jest.mock("@/components/OfficerTopBar", () => ({
  OfficerTopBar: ({ label, action }: { label: string; action?: React.ReactNode }) => (
    <div>
      {label}
      {action}
    </div>
  ),
}));
jest.mock("@/components/CameraCapture", () => ({
  CameraCapture: ({ onCapture }: { onCapture: (f: File) => void }) => (
    <button type="button" onClick={() => onCapture(new File(["x"], "site.jpg", { type: "image/jpeg" }))}>
      capture-photo
    </button>
  ),
}));
jest.mock("@/components/AIResultCard", () => ({
  AIResultCard: ({ onAccept, onOverride }: { onAccept: () => void; onOverride: () => void }) => (
    <div>
      <button type="button" onClick={onAccept}>accept-ai</button>
      <button type="button" onClick={onOverride}>override-ai</button>
    </div>
  ),
}));
jest.mock("@/components/OverrideForm", () => ({
  OverrideForm: ({ onConfirm }: { onConfirm: (c: string, r: string) => void }) => (
    <button type="button" onClick={() => onConfirm("property_damage", "Roof collapsed on site.")}>
      confirm-override
    </button>
  ),
}));
jest.mock("@/lib/imageQuality", () => ({
  assessImageQuality: jest.fn().mockResolvedValue({ blurry: false, poorExposure: false }),
}));
jest.mock("@/lib/mobilenet", () => ({ classifyImage: jest.fn() }));
jest.mock("@/lib/officerCaseReview", () => {
  const actual = jest.requireActual("@/lib/officerCaseReview");
  return {
    ...actual,
    getOfficerCase: jest.fn(),
    startOfficerReview: jest.fn(),
    submitOfficerAssessment: jest.fn(),
  };
});

const mockGet = getOfficerCase as jest.Mock;
const mockStart = startOfficerReview as jest.Mock;
const mockAssess = submitOfficerAssessment as jest.Mock;
const mockClassify = classifyImage as jest.Mock;

function detail(overrides: Record<string, unknown> = {}) {
  return {
    case: {
      canonical_id: "HEC-2026-0001", offline_id: "o-1", status: "Submitted", damage_category: "crop",
      gps_lat: 8.35, gps_lng: 80.41, submitted_at: "2026-09-17T08:00:00", updated_at: null,
      submitted_via: "app", submitted_by_officer: false, district: "අනුරාධපුරය",
      ds_division: "තලාව", household_ref: "HH-2026-0001",
    },
    workflow: {
      stage: "submitted", assigned_officer_id: null, assigned_to_me: false,
      officer_review_started_at: null, officer_assessed_at: null, assessed_by_me: false,
    },
    ai_result: null,
    ai_assisted_estimate: {
      amount_lkr: 45000, raw_estimate_lkr: 45000, capped: false, model_version: "rf_v2",
      created_at: null, is_final_decision: false,
    },
    history: [
      { event: "submitted", created_at: "2026-09-17T08:00:00" },
      { event: "push_skipped_not_configured", created_at: "2026-09-17T08:00:01" },
    ],
    actions: { can_start_review: true, can_assess: true, already_assessed: false },
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ ok: true, detail: detail() });
  mockStart.mockReset();
  mockAssess.mockReset();
  mockClassify.mockReset().mockResolvedValue({
    classId: "crop_damage", confidence: 0.9, severity: "Severe", processingTimeMs: 120,
    modelVersion: "mobilenetv2-v1", probabilities: {},
  });
  global.URL.createObjectURL = jest.fn(() => "blob:x");
  global.URL.revokeObjectURL = jest.fn();
});

it("loads exactly the case named in the URL", async () => {
  render(<OfficerCaseReviewPage />);
  expect(await screen.findByText("HEC-2026-0001")).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith("HEC-2026-0001");
  expect(screen.getByText("HH-2026-0001")).toBeInTheDocument();
  expect(screen.getByText("තලාව")).toBeInTheDocument();
});

it("labels the estimate as AI-assisted decision support, not the final compensation", async () => {
  render(<OfficerCaseReviewPage />);
  const section = await screen.findByTestId("ai-assisted-estimate");
  expect(section).toHaveTextContent("caseReview.estimateTitle");
  expect(section).toHaveTextContent("caseReview.estimateDisclaimer");
  expect(section).toHaveTextContent("LKR");
});

it("hides notification-delivery bookkeeping from the history", async () => {
  render(<OfficerCaseReviewPage />);
  const history = await screen.findByTestId("case-history");
  expect(history).toHaveTextContent("caseReview.events.submitted");
  expect(history).not.toHaveTextContent("push");
});

it("starts the review", async () => {
  mockStart.mockResolvedValue({
    ok: true,
    detail: detail({ actions: { can_start_review: false, can_assess: true, already_assessed: false } }),
  });
  render(<OfficerCaseReviewPage />);
  fireEvent.click(await screen.findByText("caseReview.startReview"));
  await waitFor(() => expect(mockStart).toHaveBeenCalledWith("HEC-2026-0001"));
  expect(await screen.findByText("caseReview.reviewStarted")).toBeInTheDocument();
  expect(screen.queryByText("caseReview.startReview")).not.toBeInTheDocument();
});

it("classifies the officer's photo on-device and submits only the accepted result", async () => {
  mockAssess.mockResolvedValue({ ok: true, detail: detail() });
  render(<OfficerCaseReviewPage />);
  fireEvent.click(await screen.findByText("capture-photo"));
  const submit = await screen.findByText("caseReview.submitAssessment");
  // Never auto-submitted: the officer must accept or override first (NFR-6.1).
  expect(submit.closest("button")).toBeDisabled();

  fireEvent.click(screen.getByText("accept-ai"));
  expect(submit.closest("button")).not.toBeDisabled();
  await act(async () => {
    fireEvent.click(submit);
  });

  expect(mockClassify).toHaveBeenCalledTimes(1);
  const [ref, body] = mockAssess.mock.calls[0];
  expect(ref).toBe("HEC-2026-0001");
  expect(body).toMatchObject({ prediction: "crop_damage", ai_severity: "Severe", was_overridden: false });
  expect(JSON.stringify(body)).not.toMatch(/blob|image|photo/i);
  expect(await screen.findByText("caseReview.assessmentRecorded")).toBeInTheDocument();
});

it("submits the officer's override alongside the model's prediction", async () => {
  mockAssess.mockResolvedValue({ ok: true, detail: detail() });
  render(<OfficerCaseReviewPage />);
  fireEvent.click(await screen.findByText("capture-photo"));
  fireEvent.click(await screen.findByText("override-ai"));
  fireEvent.click(screen.getByText("confirm-override"));
  await act(async () => {
    fireEvent.click(screen.getByText("caseReview.submitAssessment"));
  });
  expect(mockAssess.mock.calls[0][1]).toMatchObject({
    prediction: "crop_damage",
    was_overridden: true,
    override_category: "property_damage",
  });
});

it("keeps the classification on screen when submission fails, so it can be retried", async () => {
  mockAssess.mockResolvedValue({ ok: false, failure: { reason: "network" } });
  render(<OfficerCaseReviewPage />);
  fireEvent.click(await screen.findByText("capture-photo"));
  fireEvent.click(await screen.findByText("accept-ai"));
  await act(async () => {
    fireEvent.click(screen.getByText("caseReview.submitAssessment"));
  });
  expect(await screen.findByText("caseReview.error.network")).toBeInTheDocument();
  expect(screen.getByText("caseReview.submitAssessment")).toBeInTheDocument();
});

it("shows no assessment controls on a case that is no longer open", async () => {
  mockGet.mockResolvedValue({
    ok: true,
    detail: detail({ actions: { can_start_review: false, can_assess: false, already_assessed: true } }),
  });
  render(<OfficerCaseReviewPage />);
  await screen.findByText("HEC-2026-0001");
  expect(screen.queryByTestId("officer-assessment")).not.toBeInTheDocument();
});

it("says a case outside the officer's divisions was not found", async () => {
  mockGet.mockResolvedValue({ ok: false, failure: { reason: "not-found" } });
  render(<OfficerCaseReviewPage />);
  expect(await screen.findByText("caseReview.error.notFound")).toBeInTheDocument();
});

it("sends an expired session to the officer login", async () => {
  mockGet.mockResolvedValue({ ok: false, failure: { reason: "signed-out" } });
  render(<OfficerCaseReviewPage />);
  expect((await screen.findByText("dashboard.error.signIn")).closest("a")).toHaveAttribute("href", "/officer/login");
});
