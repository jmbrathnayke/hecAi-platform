/**
 * Story 8.4 — the FR-10.3 registration gate on the incident form's entrance, with the five
 * registration states of the final governance workflow (lib/registrationState.ts).
 *
 * The backend already refuses an unregistered submission with 403 not_registered. What these
 * cover is the cost of finding that out — and, since 2026-09, that a registered family is never
 * told to register again just because the check could not reach the server.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import IdentityStep from "@/app/[locale]/report/page";
import { checkRegistration } from "@/lib/registrationState";

const push = jest.fn();
const mockRouter = { push, replace: jest.fn() };
jest.mock("@/navigation", () => ({ useRouter: () => mockRouter }));
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

jest.mock("@/lib/registrationState", () => ({ checkRegistration: jest.fn() }));
const mockPutCase = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn().mockResolvedValue({}),
  putCase: (...a: unknown[]) => mockPutCase(...a),
}));
jest.mock("@/lib/draft", () => ({ getOrCreateDraftId: jest.fn(() => "draft-1") }));

const mockCheck = checkRegistration as jest.Mock;

const REGISTERED = {
  kind: "registered",
  householdRef: "HH-2026-0001",
  source: "server",
  district: "අනුරාධපුරය",
  dsDivision: "ගල්නැව",
};

beforeEach(() => {
  push.mockReset();
  mockCheck.mockReset();
  mockPutCase.mockClear();
});

it("shows a checking state while the registration lookup is in flight", () => {
  mockCheck.mockReturnValue(new Promise(() => {})); // never resolves
  render(<IdentityStep />);
  expect(screen.getByText("checking")).toBeInTheDocument();
  // The form must not flash into view before we know whether it can be submitted.
  expect(screen.queryByTestId("reporting-household")).not.toBeInTheDocument();
});

it("B: opens the report for a registered household", async () => {
  mockCheck.mockResolvedValue(REGISTERED);
  render(<IdentityStep />);
  expect(await screen.findByTestId("reporting-household")).toBeInTheDocument();
  expect(screen.queryByTestId("registration-required")).not.toBeInTheDocument();
});

it("A: blocks the form and offers registration when the citizen has no household", async () => {
  mockCheck.mockResolvedValue({ kind: "not-registered" });
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-required")).toBeInTheDocument();
  expect(screen.getByText("gate.title")).toBeInTheDocument();
  expect(screen.queryByTestId("reporting-household")).not.toBeInTheDocument();
});

it("A: sends the citizen to the registration flow", async () => {
  mockCheck.mockResolvedValue({ kind: "not-registered" });
  render(<IdentityStep />);
  (await screen.findByText("gate.register")).click();
  await waitFor(() => expect(push).toHaveBeenCalledWith("/register"));
});

it("C: asks a signed-out citizen to sign in, not to register", async () => {
  mockCheck.mockResolvedValue({ kind: "unauthenticated" });
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-sign-in")).toBeInTheDocument();
  expect(screen.queryByTestId("registration-required")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("signIn"));
  expect(push).toHaveBeenCalledWith("/login");
});

it("D: an unverifiable registration is NOT reported as unregistered, and can be retried", async () => {
  mockCheck.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce(REGISTERED);
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-unavailable")).toBeInTheDocument();
  expect(screen.getByText("unavailableBody")).toBeInTheDocument();
  expect(screen.queryByTestId("registration-required")).not.toBeInTheDocument();
  expect(screen.queryByTestId("reporting-household")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByTestId("reporting-household")).toBeInTheDocument();
  expect(mockCheck).toHaveBeenCalledTimes(2);
});

it("E: offline with a confirmed registration, the form opens and says why", async () => {
  mockCheck.mockResolvedValue({ ...REGISTERED, source: "cached" });
  render(<IdentityStep />);
  expect(await screen.findByTestId("reporting-household")).toBeInTheDocument();
  expect(screen.getByText("offlineConfirmed")).toBeInTheDocument();
});

it("asks a registered family for no NIC or phone number again", async () => {
  mockCheck.mockResolvedValue(REGISTERED);
  render(<IdentityStep />);
  const card = await screen.findByTestId("reporting-household");
  expect(card).toHaveTextContent("HH-2026-0001");
  expect(card).toHaveTextContent("අනුරාධපුරය / ගල්නැව");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("starts the draft with the household's area and moves on to the location step", async () => {
  mockCheck.mockResolvedValue(REGISTERED);
  render(<IdentityStep />);
  await screen.findByTestId("reporting-household");
  fireEvent.click(screen.getByText("step1.next"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/report/location"));
  const [record] = mockPutCase.mock.calls[0];
  expect(record).toEqual(
    expect.objectContaining({ offline_id: "draft-1", district: "අනුරාධපුරය", ds_division: "ගල්නැව" }),
  );
  expect(record).not.toHaveProperty("reporter_nic_ciphertext");
  expect(record).not.toHaveProperty("reporter_mobile_ciphertext");
});

it("offline, from the confirmed cache, still opens without an area and does not invent one", async () => {
  mockCheck.mockResolvedValue({ kind: "registered", householdRef: "HH-2026-0001", source: "cached" });
  render(<IdentityStep />);
  await screen.findByTestId("reporting-household");
  fireEvent.click(screen.getByText("step1.next"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/report/location"));
  expect(mockPutCase.mock.calls[0][0]).not.toHaveProperty("district");
});
