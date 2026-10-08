/**
 * The "Submitted by" card on the officer's case screen, the administrator's case file and the DS
 * payment card (backend case_claimant.py, 2026-10-07).
 *
 * What matters: staff can see whose claim it is and how to reach them; a case with no registered
 * household says so instead of rendering empty fields; the bank tail appears only when the server
 * sent it (DS only); and a failure says what happened rather than looking like a family with no
 * details.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimantDetails } from "@/components/ClaimantDetails";
import { fetchCaseClaimant } from "@/lib/caseClaimant";

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  useLocale: () => "en",
}));
jest.mock("@/lib/caseClaimant", () => ({ fetchCaseClaimant: jest.fn() }));
jest.mock("@/lib/dsCases", () => ({ verifyHousehold: jest.fn() }));

const mockFetch = fetchCaseClaimant as jest.Mock;

const household = {
  household_ref: "HH-2026-0007",
  district: "Anuradhapura",
  ds_division: "Galnewa",
  gn_division: "Galnewa North",
  status: "active",
  registered_at: "2026-09-20T08:30:00Z",
  address: "12, Temple Road, Galnewa",
  contact_email: "family@example.lk",
  contact_mobile: "+94771234567",
  members: [
    { full_name: "K. M. Perera", relationship: "self", is_registrant: true },
    { full_name: "S. Perera", relationship: "spouse", is_registrant: false },
  ],
};

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ ok: true, household });
});

it("fetches the claimant for exactly this case", async () => {
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  await screen.findByTestId("claimant-name");
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith("HEC-2026-0301");
});

it("shows the registrant, the household and how to reach them", async () => {
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  expect(await screen.findByTestId("claimant-name")).toHaveTextContent("K. M. Perera");
  expect(screen.getByTestId("claimant-household-ref")).toHaveTextContent("HH-2026-0007");
  expect(screen.getByTestId("claimant-address")).toHaveTextContent("12, Temple Road, Galnewa");
  expect(screen.getByText("Anuradhapura / Galnewa")).toBeInTheDocument();
  expect(screen.getByText("Galnewa North")).toBeInTheDocument();

  // Written the local way, and dialable from the officer's phone.
  const mobile = screen.getByRole("link", { name: "077 123 4567" });
  expect(mobile).toHaveAttribute("href", "tel:+94771234567");
  expect(screen.getByRole("link", { name: "family@example.lk" })).toHaveAttribute("href", "mailto:family@example.lk");
});

it("lists every declared member with their relationship", async () => {
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  const list = await screen.findByTestId("claimant-members");
  expect(list).toHaveTextContent("K. M. Perera");
  expect(list).toHaveTextContent("memberRegistrant");
  expect(list).toHaveTextContent("S. Perera");
  expect(list).toHaveTextContent("spouse");
  expect(screen.getByText('members:{"count":2}')).toBeInTheDocument();
});

it("has no bank row unless the server sent the tail (officer and admin never get it)", async () => {
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  await screen.findByTestId("claimant-name");
  expect(screen.queryByTestId("claimant-bank")).not.toBeInTheDocument();
});

it("shows the bank tail to the DS officer, whose response carries it", async () => {
  mockFetch.mockResolvedValue({ ok: true, household: { ...household, bank_account_last4: "4321" } });
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  expect(await screen.findByTestId("claimant-bank")).toHaveTextContent('bankAccountValue:{"last4":"4321"}');
});

it("says 'not recorded' for contact details the family did not give", async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    household: { ...household, contact_mobile: null, contact_email: null, gn_division: null },
  });
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  expect(await screen.findByTestId("claimant-mobile")).toHaveTextContent("notRecorded");
  expect(screen.getByTestId("claimant-email")).toHaveTextContent("notRecorded");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("says so when the case has no registered household", async () => {
  mockFetch.mockResolvedValue({ ok: true, household: null });
  render(<ClaimantDetails caseRef="HEC-2026-0010" />);
  expect(await screen.findByTestId("claimant-none")).toHaveTextContent("noHousehold");
  expect(screen.queryByTestId("claimant-name")).not.toBeInTheDocument();
});

it("explains a failure and can retry", async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, failure: { reason: "network" } });
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("error.generic");
  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByTestId("claimant-name")).toHaveTextContent("K. M. Perera");
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it("tells a signed-out user to sign in again", async () => {
  mockFetch.mockResolvedValue({ ok: false, failure: { reason: "signed-out" } });
  render(<ClaimantDetails caseRef="HEC-2026-0301" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("error.signedOut");
});

// --------------------------------------------------------------- migration 041
describe("a household a field officer registered", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyHousehold } = require("@/lib/dsCases") as { verifyHousehold: jest.Mock };
  const provisional = { ...household, registered_by_officer: true, verified_at: null, provisional: true };

  it("says payment is held until the DS office verifies it", async () => {
    mockFetch.mockResolvedValue({ ok: true, household: provisional });
    render(<ClaimantDetails caseRef="HEC-2026-0301" />);
    expect(await screen.findByTestId("claimant-provisional")).toHaveTextContent("provisional");
    // Only the DS office can verify; the officer and the administrator only see the notice.
    expect(screen.queryByTestId("claimant-verify")).not.toBeInTheDocument();
  });

  it("lets the DS office verify it with a written note, then reloads", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, household: provisional })
      .mockResolvedValueOnce({ ok: true, household: { ...provisional, provisional: false,
        verified_at: "2026-10-08T09:00:00Z" } });
    verifyHousehold.mockReset().mockResolvedValue({ ok: true, householdRef: "HH-2026-0007",
      verifiedAt: "2026-10-08T09:00:00Z" });
    render(<ClaimantDetails caseRef="HEC-2026-0301" canVerify />);
    await screen.findByTestId("claimant-verify");

    fireEvent.click(screen.getByRole("button", { name: "verifySubmit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("verifyNoteRequired");
    expect(verifyHousehold).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("verifyNote"), {
      target: { value: "Checked the NIC card and GN register" },
    });
    fireEvent.click(screen.getByRole("button", { name: "verifySubmit" }));
    expect(await screen.findByTestId("claimant-verified")).toBeInTheDocument();
    expect(verifyHousehold).toHaveBeenCalledWith("HH-2026-0007", "Checked the NIC card and GN register");
    expect(screen.queryByTestId("claimant-provisional")).not.toBeInTheDocument();
  });

  it("shows nothing extra for a family that registered itself", async () => {
    render(<ClaimantDetails caseRef="HEC-2026-0301" canVerify />);
    await screen.findByTestId("claimant-name");
    expect(screen.queryByTestId("claimant-provisional")).not.toBeInTheDocument();
    expect(screen.queryByTestId("claimant-verified")).not.toBeInTheDocument();
  });
});
