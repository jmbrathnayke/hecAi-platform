import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HouseholdDetailsForm } from "@/components/HouseholdDetailsForm";
import { updateMyHousehold, type Household } from "@/lib/households";

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, string>) =>
    v ? `${k}:${Object.values(v).join(",")}` : k,
}));
jest.mock("@/lib/households", () => ({ updateMyHousehold: jest.fn() }));

const mockUpdate = updateMyHousehold as jest.Mock;

const HOUSEHOLD: Household = {
  household_ref: "HH-2026-0005",
  district: "අනුරාධපුරය",
  ds_division: "ගල්නැව",
  gn_division: null,
  status: "active",
  registered_at: null,
  address: "No. 21, Kanal Road, Galnewa",
  contact_email: null,
  bank_account_last4: null,
  members: [{ full_name: "Dev Test Citizen", relationship: "self", is_registrant: true }],
};

function renderForm(household: Household = HOUSEHOLD) {
  const handlers = { onSaved: jest.fn(), onCancel: jest.fn(), onSessionEnded: jest.fn() };
  render(<HouseholdDetailsForm household={household} {...handlers} />);
  return handlers;
}

beforeEach(() => mockUpdate.mockReset());

it("never offers the area or family members for editing", () => {
  renderForm();
  expect(screen.getByText("lockedNote")).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getAllByRole("textbox").map((el) => el.id).sort()).toEqual(
    ["edit-account", "edit-address", "edit-bank", "edit-branch", "edit-email", "edit-gn", "edit-holder"].sort(),
  );
});

it("sends only the fields that changed", async () => {
  const updated = { ...HOUSEHOLD, contact_email: "family@example.lk" };
  mockUpdate.mockResolvedValue({ ok: true, household: updated });
  const { onSaved } = renderForm();

  fireEvent.change(screen.getByLabelText("contactEmail"), { target: { value: " family@example.lk " } });
  fireEvent.click(screen.getByText("save"));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  expect(mockUpdate).toHaveBeenCalledWith({ contact_email: "family@example.lk" });
});

it("with nothing changed, simply closes without a request", () => {
  const { onCancel } = renderForm();
  fireEvent.click(screen.getByText("save"));
  expect(onCancel).toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("will not blank the required address, and checks the email shape", () => {
  renderForm();
  fireEvent.change(screen.getByLabelText("address"), { target: { value: "   " } });
  fireEvent.click(screen.getByText("save"));
  expect(screen.getByRole("alert")).toHaveTextContent("addressRequired");

  fireEvent.change(screen.getByLabelText("address"), { target: { value: "No. 1, Road" } });
  fireEvent.change(screen.getByLabelText("contactEmail"), { target: { value: "not an email" } });
  fireEvent.click(screen.getByText("save"));
  expect(screen.getByRole("alert")).toHaveTextContent("emailInvalid");
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("lets a family with no bank details add them, holder defaulting to the registrant", async () => {
  mockUpdate.mockResolvedValue({ ok: true, household: { ...HOUSEHOLD, bank_account_last4: "5678" } });
  renderForm();
  expect(screen.getByLabelText("accountHolder")).toHaveValue("Dev Test Citizen");
  fireEvent.change(screen.getByLabelText("accountNumber"), { target: { value: "0012345678" } });
  fireEvent.change(screen.getByLabelText("bankName"), { target: { value: "BOC" } });
  fireEvent.click(screen.getByText("save"));
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  expect(mockUpdate.mock.calls[0][0]).toEqual({
    bank: { account_number: "0012345678", bank_name: "BOC", branch: undefined, account_holder: "Dev Test Citizen" },
  });
});

it("with bank details on file, shows only the tail and where to change them", () => {
  renderForm({ ...HOUSEHOLD, bank_account_last4: "5678" });
  expect(screen.queryByLabelText("accountNumber")).not.toBeInTheDocument();
  expect(screen.getByText(/bankAccountValue:5678/)).toBeInTheDocument();
  expect(screen.getByText("bankLocked")).toBeInTheDocument();
});

it.each([
  ["bank-locked", "bankAlreadyOnFile"],
  ["invalid-bank", "bankInvalid"],
  ["invalid-email", "emailInvalid"],
  ["network", "saveError"],
])("explains a %s refusal", async (reason, message) => {
  mockUpdate.mockResolvedValue({ ok: false, failure: { reason } });
  renderForm();
  fireEvent.change(screen.getByLabelText("gnDivision"), { target: { value: "Galnewa North" } });
  fireEvent.click(screen.getByText("save"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
});

it("hands an expired session back to the page", async () => {
  mockUpdate.mockResolvedValue({ ok: false, failure: { reason: "no-session" } });
  const { onSessionEnded } = renderForm();
  fireEvent.change(screen.getByLabelText("gnDivision"), { target: { value: "Galnewa North" } });
  fireEvent.click(screen.getByText("save"));
  await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
});
