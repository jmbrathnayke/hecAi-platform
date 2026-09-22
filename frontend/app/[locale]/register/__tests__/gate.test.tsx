/**
 * The registration page checks first (final governance workflow). A family that has already
 * registered is shown its household reference and "Report an incident" — never the form again.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import RegisterHouseholdPage from "@/app/[locale]/register/page";
import { checkRegistration, rememberRegistrationForCurrentAccount } from "@/lib/registrationState";
import { registerHousehold } from "@/lib/households";

const push = jest.fn();
const mockRouter = { push, replace: jest.fn() };
jest.mock("@/navigation", () => ({
  useRouter: () => mockRouter,
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("@/components/DistrictPicker", () => ({
  DistrictPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ district: "අනුරාධපුරය", dsDivision: "තලාව" })}>
      pick-area
    </button>
  ),
}));
jest.mock("@/lib/households", () => ({ registerHousehold: jest.fn() }));
jest.mock("@/lib/registrationState", () => ({
  checkRegistration: jest.fn(),
  rememberRegistrationForCurrentAccount: jest.fn().mockResolvedValue(undefined),
}));

const mockCheck = checkRegistration as jest.Mock;
const mockRemember = rememberRegistrationForCurrentAccount as jest.Mock;
const mockRegister = registerHousehold as jest.Mock;

beforeEach(() => {
  push.mockReset();
  mockCheck.mockReset();
  mockRemember.mockClear();
  mockRegister.mockReset();
});

it("does not show the form while the check is in flight", () => {
  mockCheck.mockReturnValue(new Promise(() => {}));
  render(<RegisterHouseholdPage />);
  expect(screen.getByTestId("registration-checking")).toBeInTheDocument();
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
});

it("B: an already-registered family sees its reference and Report an incident, not the form", async () => {
  mockCheck.mockResolvedValue({ kind: "registered", householdRef: "HH-2026-0001", source: "server" });
  render(<RegisterHouseholdPage />);
  expect(await screen.findByTestId("household-conflict")).toBeInTheDocument();
  expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0001");
  expect(screen.getByText("conflict.reportIncident").closest("a")).toHaveAttribute("href", "/report");
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
});

it("E: offline with a confirmed registration still shows the registered state", async () => {
  mockCheck.mockResolvedValue({ kind: "registered", householdRef: "HH-2026-0001", source: "cached" });
  render(<RegisterHouseholdPage />);
  expect(await screen.findByTestId("household-conflict")).toBeInTheDocument();
});

it("A: an unregistered account gets the form", async () => {
  mockCheck.mockResolvedValue({ kind: "not-registered" });
  render(<RegisterHouseholdPage />);
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
});

it("C: a signed-out visitor is asked to sign in", async () => {
  mockCheck.mockResolvedValue({ kind: "unauthenticated" });
  render(<RegisterHouseholdPage />);
  fireEvent.click(await screen.findByText("signIn"));
  expect(push).toHaveBeenCalledWith("/login");
});

it("D: a failed check offers retry instead of the form", async () => {
  mockCheck.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind: "not-registered" });
  render(<RegisterHouseholdPage />);
  expect(await screen.findByTestId("registration-unavailable")).toBeInTheDocument();
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
});

it("remembers the household the server confirms at registration", async () => {
  mockCheck.mockResolvedValue({ kind: "not-registered" });
  mockRegister.mockResolvedValue({
    ok: true, householdRef: "HH-2026-0042", district: "අනුරාධපුරය", dsDivision: "තලාව",
    memberCount: 1, bankAccountLast4: null,
  });
  render(<RegisterHouseholdPage />);
  fireEvent.change(await screen.findByLabelText("step1.nic"), { target: { value: "200133502343" } });
  fireEvent.click(screen.getByText("next")); // -> family
  fireEvent.click(screen.getByText("next")); // -> area
  fireEvent.click(screen.getByText("pick-area"));
  fireEvent.click(screen.getByText("next")); // -> bank (optional)
  fireEvent.click(screen.getByText("submit"));
  expect(await screen.findByTestId("registration-receipt")).toBeInTheDocument();
  expect(mockRemember).toHaveBeenCalledWith("HH-2026-0042");
});
