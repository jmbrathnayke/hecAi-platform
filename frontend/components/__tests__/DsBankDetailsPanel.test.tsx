import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DsBankDetailsPanel } from "@/components/DsBankDetailsPanel";
import { setHouseholdBankDetails } from "@/lib/dsCases";

jest.mock("@/lib/dsCases", () => ({ setHouseholdBankDetails: jest.fn() }));

const mockSet = setHouseholdBankDetails as jest.Mock;
const t = (k: string, v?: Record<string, string | number>) =>
  v ? `${k}:${Object.values(v).join(",")}` : k;

const REASON = "Account closed; family brought a new passbook.";

function renderPanel(currentLast4: string | null = "5678") {
  const handlers = { onSaved: jest.fn(), onClose: jest.fn() };
  const view = render(
    <DsBankDetailsPanel householdRef="HH-2026-0001" currentLast4={currentLast4} t={t} {...handlers} />,
  );
  return { ...handlers, unmount: view.unmount };
}

beforeEach(() => mockSet.mockReset());

it("shows what is on file, or that nothing is", () => {
  const { unmount } = renderPanel("5678");
  expect(screen.getByText("bankDetails.current:5678")).toBeInTheDocument();
  unmount();
  renderPanel(null);
  expect(screen.getByText("bankDetails.none")).toBeInTheDocument();
});

it("records the account with its reason and reports the new tail", async () => {
  mockSet.mockResolvedValue({ ok: true, householdRef: "HH-2026-0001", last4: "3210", replacedExisting: true });
  const { onSaved } = renderPanel();

  fireEvent.change(screen.getByLabelText("bankDetails.accountNumber"), { target: { value: " 7009876543210 " } });
  fireEvent.change(screen.getByLabelText("bankDetails.bankName"), { target: { value: "People's Bank" } });
  fireEvent.change(screen.getByLabelText("bankDetails.reasonLabel"), { target: { value: REASON } });
  fireEvent.click(screen.getByText("bankDetails.save"));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("3210"));
  expect(mockSet).toHaveBeenCalledWith(
    "HH-2026-0001",
    { account_number: "7009876543210", bank_name: "People's Bank", branch: undefined, account_holder: undefined },
    REASON,
  );
  expect(screen.getByText("bankDetails.saved:3210")).toBeInTheDocument();
});

it("will not send a change with no account number, or with too short a reason", () => {
  renderPanel();
  fireEvent.change(screen.getByLabelText("bankDetails.reasonLabel"), { target: { value: REASON } });
  fireEvent.click(screen.getByText("bankDetails.save"));
  expect(screen.getByRole("alert")).toHaveTextContent("bankDetails.error.invalidBank");

  fireEvent.change(screen.getByLabelText("bankDetails.accountNumber"), { target: { value: "7009876543210" } });
  fireEvent.change(screen.getByLabelText("bankDetails.reasonLabel"), { target: { value: "too short" } });
  fireEvent.click(screen.getByText("bankDetails.save"));
  expect(screen.getByRole("alert")).toHaveTextContent("bankDetails.error.reasonRequired");
  expect(mockSet).not.toHaveBeenCalled();
});

it.each([
  ["not-found", "bankDetails.error.notFound"],
  ["reason-required", "bankDetails.error.reasonRequired"],
  ["invalid-bank", "bankDetails.error.invalidBank"],
  ["network", "bankDetails.error.network"],
])("explains a %s refusal from the server", async (reason, message) => {
  mockSet.mockResolvedValue({ ok: false, failure: { reason } });
  const { onSaved } = renderPanel();
  fireEvent.change(screen.getByLabelText("bankDetails.accountNumber"), { target: { value: "700987" } });
  fireEvent.change(screen.getByLabelText("bankDetails.reasonLabel"), { target: { value: REASON } });
  fireEvent.click(screen.getByText("bankDetails.save"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
  expect(onSaved).not.toHaveBeenCalled();
});

it("never shows the account number back after saving", async () => {
  mockSet.mockResolvedValue({ ok: true, householdRef: "HH-2026-0001", last4: "3210", replacedExisting: false });
  renderPanel(null);
  fireEvent.change(screen.getByLabelText("bankDetails.accountNumber"), { target: { value: "7009876543210" } });
  fireEvent.change(screen.getByLabelText("bankDetails.reasonLabel"), { target: { value: REASON } });
  fireEvent.click(screen.getByText("bankDetails.save"));
  await screen.findByText("bankDetails.saved:3210");
  expect(document.body.textContent).not.toContain("7009876543210");
});
