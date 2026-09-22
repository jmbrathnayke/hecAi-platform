/**
 * The Divisional Secretariat's final compensation decision (final governance workflow). The AI
 * estimate and the DWC recommendation are inputs a human weighs; the officer records the decision.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DsFinalDecisionPanel } from "@/components/DsFinalDecisionPanel";
import { recordFinalDecision, type DsCase } from "@/lib/dsCases";

jest.mock("@/lib/dsCases", () => ({ recordFinalDecision: jest.fn() }));

const mockRecord = recordFinalDecision as jest.Mock;
const t = (k: string) => k;

function approved(over: Partial<DsCase> = {}): DsCase {
  return {
    canonical_id: "HEC-2026-0010",
    offline_id: "o-10",
    status: "Approved",
    damage_category: "crop",
    submitted_via: "app",
    submitted_at: null,
    updated_at: null,
    approved_amount: 42000,
    household_ref: "HH-2026-0001",
    ai_estimate: { amount_lkr: 45000, model_version: "rf_v2", is_final_decision: false },
    officer_assessed: true,
    final_decision: null,
    payment_authorized: false,
    ...over,
  };
}

const DECISION = {
  amount_lkr: 45000, reason: null, decided_at: "2026-09-17T10:00:00", is_final_decision: true,
  revised: false, unchanged: false,
};

beforeEach(() => mockRecord.mockReset());

function amountInput() {
  return screen.getByLabelText("finalDecision.amountLabel") as HTMLInputElement;
}
function reasonInput() {
  return screen.getByLabelText(/finalDecision.reasonLabel/) as HTMLTextAreaElement;
}
function confirmButton() {
  return screen.getByText("finalDecision.confirm").closest("button")!;
}

it("shows the AI-assisted estimate labelled as decision support, beside the DWC recommendation", () => {
  render(<DsFinalDecisionPanel dsCase={approved()} t={t} onDecided={jest.fn()} onCancel={jest.fn()} />);
  const ai = screen.getByTestId("ds-ai-estimate");
  expect(ai).toHaveTextContent("finalDecision.aiEstimate");
  expect(ai).toHaveTextContent("45,000");
  expect(ai).toHaveTextContent("finalDecision.aiEstimateNote");
  expect(screen.getByText("finalDecision.dwcAmount")).toBeInTheDocument();
  expect(screen.getByText("finalDecision.humanDecision")).toBeInTheDocument();
});

it("confirms the AI estimate without a reason", async () => {
  mockRecord.mockResolvedValue({ ok: true, decision: DECISION, aiEstimate: 45000, dwcAmount: 42000 });
  const onDecided = jest.fn();
  render(<DsFinalDecisionPanel dsCase={approved()} t={t} onDecided={onDecided} onCancel={jest.fn()} />);
  fireEvent.change(amountInput(), { target: { value: "45000" } });
  expect(confirmButton()).not.toBeDisabled();
  await act(async () => {
    fireEvent.click(confirmButton());
  });
  expect(mockRecord).toHaveBeenCalledWith("HEC-2026-0010", 45000, null);
  expect(onDecided).toHaveBeenCalledWith(DECISION);
});

it("requires a reason before recording an amount that departs from the AI estimate", async () => {
  mockRecord.mockResolvedValue({ ok: true, decision: { ...DECISION, amount_lkr: 42000 }, aiEstimate: 45000, dwcAmount: 42000 });
  render(<DsFinalDecisionPanel dsCase={approved()} t={t} onDecided={jest.fn()} onCancel={jest.fn()} />);
  // Pre-filled with the DWC recommendation (42,000), which differs from the estimate.
  expect(amountInput().value).toBe("42000");
  expect(confirmButton()).toBeDisabled();
  fireEvent.change(reasonInput(), { target: { value: "Site visit: half the crop was salvageable." } });
  expect(confirmButton()).not.toBeDisabled();
  await act(async () => {
    fireEvent.click(confirmButton());
  });
  expect(mockRecord).toHaveBeenCalledWith("HEC-2026-0010", 42000, "Site visit: half the crop was salvageable.");
});

it("refuses a negative or empty amount", () => {
  render(<DsFinalDecisionPanel dsCase={approved()} t={t} onDecided={jest.fn()} onCancel={jest.fn()} />);
  fireEvent.change(reasonInput(), { target: { value: "A sufficiently long reason." } });
  fireEvent.change(amountInput(), { target: { value: "-5" } });
  expect(confirmButton()).toBeDisabled();
  fireEvent.change(amountInput(), { target: { value: "" } });
  expect(confirmButton()).toBeDisabled();
});

it("shows the server's refusal", async () => {
  mockRecord.mockResolvedValue({ ok: false, failure: { reason: "payment-authorized" } });
  render(<DsFinalDecisionPanel dsCase={approved()} t={t} onDecided={jest.fn()} onCancel={jest.fn()} />);
  fireEvent.change(amountInput(), { target: { value: "45000" } });
  await act(async () => {
    fireEvent.click(confirmButton());
  });
  expect(screen.getByRole("alert")).toHaveTextContent("finalDecision.error.paymentAuthorized");
});
