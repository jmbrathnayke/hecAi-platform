/**
 * Admin portal, final governance workflow: a citizen report is approved only after a field
 * officer's assessment; approval forwards to the Divisional Secretariat, which decides the amount;
 * the compensation figure is labelled an AI-assisted estimate throughout.
 */
import { render, screen } from "@testing-library/react";
import { CaseActionPanel } from "../CaseActionPanel";
import { CaseDetailPanel } from "../CaseDetailPanel";
import { CompensationPanel } from "../CompensationPanel";
import { fetchAdminCaseDetail } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminCaseDetail", () => ({
  fetchAdminCaseDetail: jest.fn(),
  verifyAuditChain: jest.fn().mockResolvedValue({ valid: true, broken_id: null }),
  performCaseAction: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockFetch = fetchAdminCaseDetail as jest.Mock;

beforeEach(() => {
  (getAccessToken as jest.Mock).mockResolvedValue("tok");
});

function panel(props: Partial<React.ComponentProps<typeof CaseActionPanel>>) {
  return render(
    <CaseActionPanel
      offlineId="off-1"
      status="Submitted"
      hasEstimate
      estimateAmountLkr={45000}
      onActionComplete={jest.fn()}
      {...props}
    />,
  );
}

describe("CaseActionPanel", () => {
  test("an unverified citizen report cannot be approved, but can still be rejected", () => {
    panel({ officerAssessed: false });
    expect(screen.getByTestId("assessment-required")).toHaveTextContent("action.assessmentRequired");
    expect(screen.getByRole("button", { name: /^action\.approve$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^action\.reject$/ })).not.toBeDisabled();
  });

  test("an assessed case can be approved, with the forward-to-DS note in the dialog", () => {
    panel({ officerAssessed: true });
    const approve = screen.getByRole("button", { name: /^action\.approve$/ });
    expect(approve).not.toBeDisabled();
    approve.click();
    return screen.findByText("action.forwardNote");
  });

  test("an approved case awaiting the DS decision offers no payment action", () => {
    panel({ status: "Approved", dsFinalDecided: false });
    expect(screen.getByTestId("awaiting-ds-decision")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /action\.markPaid/ })).not.toBeInTheDocument();
  });

  test("unknown workflow state (older backend) behaves exactly as before", () => {
    panel({ status: "Approved" });
    expect(screen.getByRole("button", { name: /action\.markPaid/ })).toBeInTheDocument();
  });
});

describe("CompensationPanel", () => {
  test("labels the estimate as AI-assisted, not the final compensation", () => {
    render(
      <CompensationPanel
        compensation={{
          amount_lkr: 45000, raw_estimate_lkr: 45000, capped: false, feature_values: {},
          model_version: "rf_v2", dataset_version: "2021", created_at: null, is_final_decision: false,
        }}
      />,
    );
    expect(screen.getByTestId("compensation-not-final")).toHaveTextContent("compensation.notFinal");
  });
});

describe("CaseDetailPanel workflow", () => {
  function response(workflow: Record<string, unknown>) {
    return {
      case: {
        canonical_id: "HEC-2026-0001", offline_id: "off-1", damage_category: "crop", status: "Under Review",
        gps_lat: null, gps_lng: null, submitted_at: null, updated_at: null, submitted_via: "app",
        submitted_by_officer: false, submitter_identity_hash: null, approved_amount: null,
      },
      ai_result: null,
      compensation: null,
      audit_trail: [],
      workflow: {
        stage: "officer_assessed", district: "අනුරාධපුරය", ds_division: "තලාව",
        responsible_officer_id: "officer-1", officer_review_started_at: null,
        officer_assessed_at: "2026-09-17T09:00:00", officer_assessed_by: "officer-1",
        officer_assessed: true, ds_final_amount: null, ds_final_reason: null, ds_final_at: null,
        ...workflow,
      },
    };
  }

  test("shows district, division, responsible officer and stage", async () => {
    mockFetch.mockResolvedValue(response({}));
    render(<CaseDetailPanel offlineId="off-1" />);
    const wf = await screen.findByTestId("workflow-panel");
    expect(wf).toHaveTextContent("තලාව");
    expect(wf).toHaveTextContent("officer-1");
    expect(wf).toHaveTextContent("stageLabels.officer_assessed");
    expect(screen.getByTestId("workflow-ds-final")).toHaveTextContent("workflow.dsFinalPending");
    // Assessed by an officer after the citizen submitted: verified, and approvable.
    expect(screen.getByText("table.verifiedByOfficer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^action\.approve$/ })).not.toBeDisabled();
  });

  test("an unassessed citizen report is shown as not verified and cannot be approved", async () => {
    mockFetch.mockResolvedValue(response({ stage: "submitted", officer_assessed: false, officer_assessed_at: null }));
    render(<CaseDetailPanel offlineId="off-1" />);
    expect(await screen.findByTestId("assessment-required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^action\.approve$/ })).toBeDisabled();
  });

  test("shows the DS final decision once recorded", async () => {
    mockFetch.mockResolvedValue(response({ ds_final_amount: 40000, ds_final_reason: "Adjusted on inspection.", ds_final_at: "2026-09-17T11:00:00" }));
    render(<CaseDetailPanel offlineId="off-1" />);
    const ds = await screen.findByTestId("workflow-ds-final");
    expect(ds).toHaveTextContent("40,000");
    expect(ds).toHaveTextContent("Adjusted on inspection.");
  });
});
