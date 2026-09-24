import { fireEvent, render, screen, waitFor } from "@testing-library/react";
// The form itself. Since the final governance workflow the route first checks whether this account
// is already registered (tested in gate.test.tsx) and renders this component only when it is not.
import RegisterHouseholdPage from "@/components/RegisterHouseholdForm";
import { registerHousehold } from "@/lib/households";

const push = jest.fn();
const mockRouter = { push, replace: jest.fn() };
// `Link` is needed as well as `useRouter`: the Story 8.3 conflict screen renders locale-aware
// links, and a mock that omits it makes <Link> undefined, which throws on render.
jest.mock("@/navigation", () => ({
  useRouter: () => mockRouter,
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Identity translator: t("step1.title") -> "step1.title" (same pattern as the report tests).
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

// DistrictPicker has its own test file; here it is reduced to a button that emits one valid
// selection, so these tests exercise the registration page rather than the picker.
jest.mock("@/components/DistrictPicker", () => ({
  DistrictPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ district: "අනුරාධපුරය", dsDivision: "තලාව" })}>
      pick-area
    </button>
  ),
}));

jest.mock("@/lib/households", () => ({ registerHousehold: jest.fn() }));

const mockRegister = registerHousehold as jest.Mock;

const NIC_CURRENT = "200133502343";
const NIC_MEMBER = "751234567V";

beforeEach(() => {
  push.mockReset();
  mockRegister.mockReset().mockResolvedValue({
    ok: true,
    householdRef: "HH-2026-0001",
    district: "අනුරාධපුරය",
    dsDivision: "තලාව",
    memberCount: 1,
  });
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const ADDRESS = "No. 12, Tank Road, Thalawa";

/** The area step needs a picked district/division AND a home address (migration 035). */
function pickAreaAndAddress(address = ADDRESS) {
  fireEvent.click(screen.getByText("pick-area"));
  fireEvent.change(screen.getByLabelText("step3.addressLabel"), { target: { value: address } });
}

/** Fill step 1 with a valid NIC and advance. */
function completeStep1(nic = NIC_CURRENT) {
  fireEvent.change(screen.getByLabelText("step1.nic"), { target: { value: nic } });
  fireEvent.click(screen.getByText("next"));
}

/** Walk all the way to the final step, with an area picked and the optional bank step skipped. */
function reachStep3(nic = NIC_CURRENT) {
  completeStep1(nic);
  fireEvent.click(screen.getByText("next")); // skip the family step
  pickAreaAndAddress();
  fireEvent.click(screen.getByText("next")); // Story 8.6 added the optional bank step
}

describe("step navigation", () => {
  it("starts on the registrant step", () => {
    render(<RegisterHouseholdPage />);
    expect(screen.getByText("step1.title")).toBeInTheDocument();
    expect(screen.getByLabelText("step1.nic")).toBeInTheDocument();
  });

  it("refuses to advance past an invalid NIC", () => {
    render(<RegisterHouseholdPage />);
    fireEvent.change(screen.getByLabelText("step1.nic"), { target: { value: "12345" } });
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("alert")).toHaveTextContent("step1.nicError");
    expect(screen.getByText("step1.title")).toBeInTheDocument();
  });

  it("advances to the family step on a valid NIC", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    expect(screen.getByText("step2.title")).toBeInTheDocument();
  });

  it("explains WHY only one person registers, on the family step", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    // Stated as a reason before anyone is blocked, not as an error afterwards.
    expect(screen.getByText("step2.why")).toBeInTheDocument();
  });

  it("goes back without losing the entered NIC", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByLabelText("step1.nic")).toHaveValue(NIC_CURRENT);
  });
});

describe("family members", () => {
  it("adds and removes member rows", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    expect(screen.getByText("step2.memberN")).toBeInTheDocument();
    fireEvent.click(screen.getByText("step2.remove"));
    expect(screen.queryByText("step2.memberN")).not.toBeInTheDocument();
  });

  it("rejects an invalid member NIC", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    const input = screen.getAllByLabelText("step2.nic")[0];
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("alert")).toHaveTextContent("step2.nicError");
  });

  it("ignores a blank member row rather than rejecting it", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByText("step3.title")).toBeInTheDocument();
  });

  it("catches the registrant listing their own NIC as a family member", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    fireEvent.change(screen.getAllByLabelText("step2.nic")[0], {
      target: { value: NIC_CURRENT },
    });
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("alert")).toHaveTextContent("step2.duplicateError");
  });
});

describe("submission", () => {
  it("will not leave the area step without an area", () => {
    // Story 8.6 moved this check earlier: the bank step now sits after the area step, so an
    // unset area has to be caught on the way out of step 3 rather than at submit.
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("alert")).toHaveTextContent("step3.areaError");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("will not leave the area step without a home address", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("next"));
    pickAreaAndAddress("   ");
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("alert")).toHaveTextContent("step3.addressError");
    expect(screen.getByText("step3.title")).toBeInTheDocument();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("posts the registrant, members and area", async () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    fireEvent.change(screen.getAllByLabelText("step2.nic")[0], {
      target: { value: NIC_MEMBER },
    });
    fireEvent.click(screen.getByText("next"));
    pickAreaAndAddress();
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("submit"));

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        nic: NIC_CURRENT,
        district: "අනුරාධපුරය",
        ds_division: "තලාව",
        members: [expect.objectContaining({ nic: NIC_MEMBER })],
      }),
    );
  });

  it("shows the household reference on success", async () => {
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    const receipt = await screen.findByTestId("registration-receipt");
    expect(receipt).toHaveTextContent("HH-2026-0001");
    expect(screen.getByText("done.reportIncident")).toBeInTheDocument();
  });

  it("sends the citizen on to report an incident from the receipt", async () => {
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    fireEvent.click(await screen.findByText("done.reportIncident"));
    expect(push).toHaveBeenCalledWith("/report");
  });
});

describe("failures", () => {
  it("REPLACES the form when the citizen's OWN nic is already registered (Story 8.3)", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "nic-taken", scope: "registrant", householdRef: "HH-2026-0042" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    // The family is in the registry; there is nothing on this form left to correct, so the form
    // is gone rather than sitting under a red line offering a fix that does not exist.
    expect(await screen.findByTestId("household-conflict")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0042");
    expect(screen.getByText("conflict.titleFamily")).toBeInTheDocument();
    expect(screen.queryByText("submit")).not.toBeInTheDocument();
    // Retrying cannot free an occupied NIC.
    expect(screen.queryByText("retry")).not.toBeInTheDocument();
  });

  it("falls back to an inline message when the 409 carries no reference to show", async () => {
    // A takeover screen whose whole point is to hand over a number is useless without one.
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "nic-taken", scope: "registrant", householdRef: "" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.nicTakenRegistrant")).toBeInTheDocument();
    expect(screen.queryByTestId("household-conflict")).not.toBeInTheDocument();
  });

  it("does NOT reveal another family's reference on a member clash", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "nic-taken", scope: "member" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.nicTakenMember")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-household-ref")).not.toBeInTheDocument();
  });

  it("shows the own-account variant to a citizen who already registered (Story 8.3)", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "already-registered", householdRef: "HH-2026-0007" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByTestId("household-conflict")).toBeInTheDocument();
    expect(screen.getByText("conflict.titleYou")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0007");
    // This citizen has a household already — send them on, not to the DS office.
    expect(screen.getByText("conflict.reportIncident")).toBeInTheDocument();
    expect(screen.queryByText("conflict.whatToDo")).not.toBeInTheDocument();
  });

  it("offers retry on a network failure", async () => {
    mockRegister.mockResolvedValue({ ok: false, failure: { reason: "network" } });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.network")).toBeInTheDocument();
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
  });

  it("offers retry on a server failure", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "server", status: 500, code: "server_error" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    expect(await screen.findByText("error.server")).toBeInTheDocument();
    expect(screen.getByText("retry")).toBeInTheDocument();
  });

  it("does not offer retry when the app has no Supabase configuration", async () => {
    mockRegister.mockResolvedValue({ ok: false, failure: { reason: "config" } });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    expect(await screen.findByText("error.config")).toBeInTheDocument();
    expect(screen.queryByText("retry")).not.toBeInTheDocument();
  });

  it("reports a server-side cross-format duplicate the client cannot catch", async () => {
    // The client compares strings, so 200133502343 and its legacy card look different to it.
    // Only the server's canonicalisation catches that pair — the UI must surface the result.
    mockRegister.mockResolvedValue({ ok: false, failure: { reason: "duplicate-nic-in-form" } });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    expect(await screen.findByText("error.duplicateInForm")).toBeInTheDocument();
  });
});

describe("PII discipline (NFR-3.1)", () => {
  it("never writes a NIC to sessionStorage or localStorage", async () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("step2.addMember"));
    fireEvent.change(screen.getAllByLabelText("step2.nic")[0], {
      target: { value: NIC_MEMBER },
    });
    fireEvent.click(screen.getByText("next"));
    pickAreaAndAddress();
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("submit"));
    await screen.findByTestId("registration-receipt");

    const dump = JSON.stringify({ ...window.sessionStorage, ...window.localStorage });
    expect(dump).not.toContain(NIC_CURRENT);
    expect(dump).not.toContain(NIC_MEMBER);
  });
});

// --- Story 8.6: the optional bank step ------------------------------------------------------

describe("bank details are optional", () => {
  it("omits `bank` entirely when the step is skipped", async () => {
    // An empty object would be a 400 from the backend; the field has to be absent, not blank.
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(mockRegister.mock.calls[0][0].bank).toBeUndefined();
  });

  it("says plainly that the step can be skipped", () => {
    render(<RegisterHouseholdPage />);
    reachStep3();
    expect(screen.getByText("step4.optional")).toBeInTheDocument();
  });

  it("sends the account when one is given", async () => {
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.change(screen.getByLabelText("step4.accountNumber"), {
      target: { value: "8001234567890" },
    });
    fireEvent.change(screen.getByLabelText("step4.bankName"), {
      target: { value: "Bank of Ceylon" },
    });
    fireEvent.click(screen.getByText("submit"));

    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(mockRegister.mock.calls[0][0].bank).toEqual(
      expect.objectContaining({
        account_number: "8001234567890",
        bank_name: "Bank of Ceylon",
      }),
    );
  });

  it("never writes the account number to browser storage", async () => {
    // Same rule as the NICs: it exists in component state, travels once over TLS, and is gone.
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.change(screen.getByLabelText("step4.accountNumber"), {
      target: { value: "8001234567890" },
    });
    fireEvent.click(screen.getByText("submit"));
    await screen.findByTestId("registration-receipt");

    const dump = JSON.stringify({ ...window.sessionStorage, ...window.localStorage });
    expect(dump).not.toContain("8001234567890");
  });

  it("surfaces a rejected account number without losing the rest of the form", async () => {
    mockRegister.mockResolvedValue({ ok: false, failure: { reason: "invalid-bank" } });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.change(screen.getByLabelText("step4.accountNumber"), {
      target: { value: "?" },
    });
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.invalidBank")).toBeInTheDocument();
    // Inline, not a takeover — this one the citizen can fix right here.
    expect(screen.queryByTestId("household-conflict")).not.toBeInTheDocument();
    expect(screen.getByLabelText("step4.accountNumber")).toBeInTheDocument();
  });
});
