import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaseActionPanel } from "../CaseActionPanel";
import { performCaseAction } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a) }),
}));

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminCaseDetail", () => ({
  performCaseAction: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockPerformCaseAction = performCaseAction as jest.Mock;

function makeDetailResponse(overrides: Record<string, unknown> = {}) {
  return {
    case: { canonical_id: "HEC-2026-0001", status: "Approved" },
    ai_result: null,
    compensation: null,
    audit_trail: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockReplace.mockReset();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockPerformCaseAction.mockReset().mockResolvedValue(makeDetailResponse());
});

function renderPanel(overrides: Partial<React.ComponentProps<typeof CaseActionPanel>> = {}) {
  const onActionComplete = jest.fn();
  const utils = render(
    <CaseActionPanel
      offlineId="off-1"
      status="Submitted"
      hasEstimate={true}
      estimateAmountLkr={45000}
      onActionComplete={onActionComplete}
      {...overrides}
    />,
  );
  return { ...utils, onActionComplete };
}

test("shows four action buttons for a Submitted case", () => {
  renderPanel({ status: "Submitted" });
  expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /request more info/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^escalate$/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /mark as paid/i })).not.toBeInTheDocument();
});

test("shows four action buttons for an Under Review case", () => {
  renderPanel({ status: "Under Review" });
  expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
});

test("shows only Mark as Paid for an Approved case", () => {
  renderPanel({ status: "Approved" });
  expect(screen.getByRole("button", { name: /mark as paid/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
});

test("shows a closed note with no buttons for a Rejected case", () => {
  renderPanel({ status: "Rejected" });
  expect(screen.getByText(/this case is closed/i)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("shows a closed note with no buttons for a Payment Processed case", () => {
  renderPanel({ status: "Payment Processed" });
  expect(screen.getByText(/this case is closed/i)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("Approve dialog pre-fills the amount from the RF estimate and confirm is enabled unchanged", () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
  const amountInput = screen.getByLabelText(/approved amount/i) as HTMLInputElement;
  expect(amountInput.value).toBe("45000");
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
});

test("Approve confirm becomes disabled until a reason is given once the amount is changed", () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
  const amountInput = screen.getByLabelText(/approved amount/i);
  fireEvent.change(amountInput, { target: { value: "60000" } });
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "too short" } });
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "Adjusted after re-inspecting the photos on file." },
  });
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
});

test("Approve with no estimate requires both an amount and a reason", () => {
  renderPanel({ hasEstimate: false, estimateAmountLkr: null });
  fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/approved amount/i), { target: { value: "30000" } });
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled(); // still needs reason

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "No RF estimate exists for this case yet." },
  });
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
});

test("Reject confirm is disabled until a reason of at least 10 characters is given", () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "short" } });
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "Photos do not show elephant damage." },
  });
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
});

test("Request More Info and Escalate confirm are enabled with no reason at all (optional)", () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /request more info/i }));
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

  fireEvent.click(screen.getByRole("button", { name: /^escalate$/i }));
  expect(screen.getByRole("button", { name: /^confirm$/i })).not.toBeDisabled();
});

test("a successful action calls onActionComplete with the response and closes the dialog", async () => {
  const response = makeDetailResponse({ case: { canonical_id: "HEC-2026-0001", status: "Under Review" } });
  mockPerformCaseAction.mockResolvedValue(response);
  const { onActionComplete } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
  await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith(response));
  expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
});

test("a failed action shows a retryable inline error and does not close the dialog", async () => {
  mockPerformCaseAction.mockResolvedValue(null);
  const { onActionComplete } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.?t complete this action/i);
  expect(onActionComplete).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^confirm$/i })).toBeInTheDocument();
});

test("the confirm button disables while the request is in flight (no double-submit)", async () => {
  let resolveAction: (value: unknown) => void = () => {};
  mockPerformCaseAction.mockReturnValue(new Promise((resolve) => { resolveAction = resolve; }));
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
  expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();
  resolveAction(makeDetailResponse());
  await waitFor(() => expect(mockPerformCaseAction).toHaveBeenCalledTimes(1));
});

test("a 401/403 from performCaseAction redirects to /admin/login", async () => {
  mockPerformCaseAction.mockResolvedValue("unauthorized");
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("calls performCaseAction with the resolved amount and reason on approve", async () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
  await waitFor(() =>
    expect(mockPerformCaseAction).toHaveBeenCalledWith("tok-123", "off-1", "approve", { amountLkr: 45000 }),
  );
});
