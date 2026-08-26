import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RegisterHouseholdPage from "@/app/[locale]/register/page";
import { registerHousehold } from "@/lib/households";

const push = jest.fn();
const mockRouter = { push, replace: jest.fn() };
jest.mock("@/navigation", () => ({ useRouter: () => mockRouter }));

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

/** Fill step 1 with a valid NIC and advance. */
function completeStep1(nic = NIC_CURRENT) {
  fireEvent.change(screen.getByLabelText("step1.nic"), { target: { value: nic } });
  fireEvent.click(screen.getByText("next"));
}

/** Walk to step 3 and pick an area. */
function reachStep3(nic = NIC_CURRENT) {
  completeStep1(nic);
  fireEvent.click(screen.getByText("next")); // skip family step
  fireEvent.click(screen.getByText("pick-area"));
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
  it("requires an area before submitting", () => {
    render(<RegisterHouseholdPage />);
    completeStep1();
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("submit"));
    expect(screen.getByRole("alert")).toHaveTextContent("step3.areaError");
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
    fireEvent.click(screen.getByText("pick-area"));
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
  it("names the household when the citizen's OWN nic is already registered", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "nic-taken", scope: "registrant", householdRef: "HH-2026-0042" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.nicTakenRegistrant")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0042");
    // Retrying cannot free an occupied NIC.
    expect(screen.queryByText("retry")).not.toBeInTheDocument();
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

  it("tells a citizen who already registered, and names their household", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      failure: { reason: "already-registered", householdRef: "HH-2026-0007" },
    });
    render(<RegisterHouseholdPage />);
    reachStep3();
    fireEvent.click(screen.getByText("submit"));

    expect(await screen.findByText("error.alreadyRegistered")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0007");
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
    fireEvent.click(screen.getByText("pick-area"));
    fireEvent.click(screen.getByText("submit"));
    await screen.findByTestId("registration-receipt");

    const dump = JSON.stringify({ ...window.sessionStorage, ...window.localStorage });
    expect(dump).not.toContain(NIC_CURRENT);
    expect(dump).not.toContain(NIC_MEMBER);
  });
});
