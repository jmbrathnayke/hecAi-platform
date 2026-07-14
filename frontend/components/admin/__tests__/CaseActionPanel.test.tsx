import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaseActionPanel } from "../CaseActionPanel";
import { performCaseAction } from "@/lib/adminCaseDetail";
import { getAccessToken } from "@/lib/auth";

// next-intl passthrough (Story 6.3): translator returns the key (+ interpolation values), so
// button/label assertions target the `admin.action.*` keys.
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
  expect(screen.getByRole("button", { name: /^action\.approve$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^action\.reject$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /action\.requestInfo/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^action\.escalate$/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /action\.markPaid/i })).not.toBeInTheDocument();
});

test("shows four action buttons for an Under Review case", () => {
  renderPanel({ status: "Under Review" });
  expect(screen.getByRole("button", { name: /^action\.approve$/i })).toBeInTheDocument();
});

test("shows only Mark as Paid for an Approved case", () => {
  renderPanel({ status: "Approved" });
  expect(screen.getByRole("button", { name: /action\.markPaid/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^action\.approve$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^action\.reject$/i })).not.toBeInTheDocument();
});

test("shows a closed note with no buttons for a Rejected case", () => {
  renderPanel({ status: "Rejected" });
  expect(screen.getByText(/action\.closed/i)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("shows a closed note with no buttons for a Payment Processed case", () => {
  renderPanel({ status: "Payment Processed" });
  expect(screen.getByText(/action\.closed/i)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("Approve dialog pre-fills the amount from the RF estimate and confirm is enabled unchanged", () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^action\.approve$/i }));
  const amountInput = screen.getByLabelText(/action\.approvedAmount/i) as HTMLInputElement;
  expect(amountInput.value).toBe("45000");
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("Approve confirm becomes disabled until a reason is given once the amount is changed", () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^action\.approve$/i }));
  const amountInput = screen.getByLabelText(/action\.approvedAmount/i);
  fireEvent.change(amountInput, { target: { value: "60000" } });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "too short" } });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "Adjusted after re-inspecting the photos on file." },
  });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("Approve with no estimate requires both an amount and a reason", () => {
  renderPanel({ hasEstimate: false, estimateAmountLkr: null });
  fireEvent.click(screen.getByRole("button", { name: /^action\.approve$/i }));
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/action\.approvedAmount/i), { target: { value: "30000" } });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled(); // still needs reason

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "No RF estimate exists for this case yet." },
  });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("Approve confirm is enabled at a zero RF estimate (code review fix)", () => {
  // A genuine 0 LKR RF estimate (no assessed damage) must remain approvable at that amount --
  // previously amountValid required > 0, permanently disabling Confirm in this case.
  renderPanel({ hasEstimate: true, estimateAmountLkr: 0 });
  fireEvent.click(screen.getByRole("button", { name: /^action\.approve$/i }));
  const amountInput = screen.getByLabelText(/action\.approvedAmount/i) as HTMLInputElement;
  expect(amountInput.value).toBe("0");
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("Reject confirm is disabled until a reason of at least 10 characters is given", () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.reject$/i }));
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "short" } });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/reason/i), {
    target: { value: "Photos do not show elephant damage." },
  });
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("Request More Info and Escalate confirm are enabled with no reason at all (optional)", () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /action\.requestInfo/i }));
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
});

test("a successful action calls onActionComplete with the response and closes the dialog", async () => {
  const response = makeDetailResponse({ case: { canonical_id: "HEC-2026-0001", status: "Under Review" } });
  mockPerformCaseAction.mockResolvedValue(response);
  const { onActionComplete } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith(response));
  expect(screen.queryByRole("button", { name: /^action\.confirm$/i })).not.toBeInTheDocument();
});

test("a failed action shows a retryable inline error and does not close the dialog", async () => {
  mockPerformCaseAction.mockResolvedValue(null);
  const { onActionComplete } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("action.actionError");
  expect(onActionComplete).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).toBeInTheDocument();
});

test("the confirm button disables while the request is in flight (no double-submit)", async () => {
  let resolveAction: (value: unknown) => void = () => {};
  mockPerformCaseAction.mockReturnValue(new Promise((resolve) => { resolveAction = resolve; }));
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();
  resolveAction(makeDetailResponse());
  await waitFor(() => expect(mockPerformCaseAction).toHaveBeenCalledTimes(1));
});

test("a 401/403 from performCaseAction redirects to /admin/login", async () => {
  mockPerformCaseAction.mockResolvedValue("unauthorized");
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a missing token redirects to login and re-enables Confirm rather than sticking on Submitting (code review fix)", async () => {
  mockGetAccessToken.mockResolvedValue(null);
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /^action\.escalate$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
  expect(screen.getByRole("button", { name: /^action\.confirm$/i })).not.toBeDisabled();
  expect(mockPerformCaseAction).not.toHaveBeenCalled();
});

test("calls performCaseAction with the resolved amount and reason on approve", async () => {
  renderPanel({ hasEstimate: true, estimateAmountLkr: 45000 });
  fireEvent.click(screen.getByRole("button", { name: /^action\.approve$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^action\.confirm$/i }));
  await waitFor(() =>
    expect(mockPerformCaseAction).toHaveBeenCalledWith("tok-123", "off-1", "approve", { amountLkr: 45000 }),
  );
});
