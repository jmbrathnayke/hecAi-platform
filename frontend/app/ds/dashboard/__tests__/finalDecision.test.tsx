/**
 * DS dashboard, final governance workflow: payment follows the recorded final decision, and a
 * notification's ?ref= opens that case's review.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DsDashboardPage from "@/app/ds/dashboard/page";
import { fetchDsCases, recordFinalDecision } from "@/lib/dsCases";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
jest.mock("@/components/PushNotificationToggle", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/dsCases", () => ({
  fetchDsCases: jest.fn(),
  recordFinalDecision: jest.fn(),
  authorizePayment: jest.fn(),
}));

const mockFetch = fetchDsCases as jest.Mock;
const mockRecord = recordFinalDecision as jest.Mock;

function approved(id: string, over: Record<string, unknown> = {}) {
  return {
    canonical_id: id, offline_id: `o-${id}`, status: "Approved", damage_category: "crop",
    submitted_via: "app", submitted_at: null, updated_at: null, approved_amount: 42000,
    household_ref: "HH-2026-0001",
    ai_estimate: { amount_lkr: 45000, model_version: "rf_v2", is_final_decision: false },
    district: "අනුරාධපුරය", officer_assessed: true, final_decision: null, payment_authorized: false,
    ...over,
  };
}

function setUrl(search: string) {
  window.history.replaceState({}, "", `/ds/dashboard${search}`);
}

beforeEach(() => {
  setUrl("");
  mockRecord.mockReset();
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    cases: [approved("HEC-2026-0010")],
    count: 1,
    dsDivision: "තලාව",
  });
});

it("does not offer payment before the final decision, and says why", async () => {
  render(<DsDashboardPage />);
  const card = (await screen.findAllByTestId("ds-case"))[0];
  expect(within(card).queryByText("payment.title")).not.toBeInTheDocument();
  expect(within(card).getByText("finalDecision.requiredBeforePayment")).toBeInTheDocument();
  expect(within(card).getByText("finalDecision.title")).toBeInTheDocument();
});

it("records the decision and then offers payment for the decided amount", async () => {
  mockRecord.mockResolvedValue({
    ok: true,
    decision: { amount_lkr: 45000, reason: null, decided_at: "2026-09-17T10:00:00", is_final_decision: true, revised: false, unchanged: false },
    aiEstimate: 45000,
    dwcAmount: 42000,
  });
  render(<DsDashboardPage />);
  fireEvent.click(await screen.findByText("finalDecision.title"));
  fireEvent.change(screen.getByLabelText("finalDecision.amountLabel"), { target: { value: "45000" } });
  await act(async () => {
    fireEvent.click(screen.getByText("finalDecision.confirm"));
  });
  expect(await screen.findByText("finalDecision.recorded")).toBeInTheDocument();
  expect(screen.getByTestId("ds-final-amount")).toHaveTextContent("45,000");
  expect(screen.getByText("payment.title")).toBeInTheDocument();
  expect(screen.getByText("finalDecision.revise")).toBeInTheDocument();
});

it("a case already decided shows the final amount and offers payment", async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    cases: [approved("HEC-2026-0011", { final_decision: { amount_lkr: 40000, reason: "Adjusted after inspection.", decided_at: null } })],
    count: 1,
    dsDivision: "තලාව",
  });
  render(<DsDashboardPage />);
  expect(await screen.findByText("payment.title")).toBeInTheDocument();
  expect(screen.getByTestId("ds-final-amount")).toHaveTextContent("40,000");
});

it("a paid case offers neither a new decision nor its revision", async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    cases: [approved("HEC-2026-0012", { status: "Payment Processed", payment_authorized: true, final_decision: { amount_lkr: 40000, reason: null, decided_at: null } })],
    count: 1,
    dsDivision: "තලාව",
  });
  render(<DsDashboardPage />);
  await screen.findAllByTestId("ds-case");
  expect(screen.queryByText("finalDecision.title")).not.toBeInTheDocument();
  expect(screen.queryByText("finalDecision.revise")).not.toBeInTheDocument();
});

it("a notification's ?ref= opens that case's final review", async () => {
  setUrl("?ref=hec-2026-0010");
  mockFetch.mockResolvedValue({
    ok: true,
    cases: [approved("HEC-2026-0009"), approved("HEC-2026-0010")],
    count: 2,
    dsDivision: "තලාව",
  });
  Element.prototype.scrollIntoView = jest.fn();
  render(<DsDashboardPage />);
  const panel = await screen.findByTestId("final-decision-panel");
  expect(panel).toHaveTextContent("HEC-2026-0010");
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
});
