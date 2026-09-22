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
jest.mock("@/lib/crypto", () => ({
  getOrCreateSessionKey: jest.fn().mockResolvedValue({}),
  encryptField: jest.fn().mockResolvedValue({ ciphertext: "c", iv: "i" }),
}));
jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn().mockResolvedValue({}),
  putCase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/draft", () => ({ getOrCreateDraftId: jest.fn(() => "draft-1") }));

const mockCheck = checkRegistration as jest.Mock;

const REGISTERED = { kind: "registered", householdRef: "HH-2026-0001", source: "server" };

beforeEach(() => {
  push.mockReset();
  mockCheck.mockReset();
});

it("shows a checking state while the registration lookup is in flight", () => {
  mockCheck.mockReturnValue(new Promise(() => {})); // never resolves
  render(<IdentityStep />);
  expect(screen.getByText("checking")).toBeInTheDocument();
  // The form must not flash into view before we know whether it can be submitted.
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
});

it("B: renders the form for a registered household", async () => {
  mockCheck.mockResolvedValue(REGISTERED);
  render(<IdentityStep />);
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
  expect(screen.queryByTestId("registration-required")).not.toBeInTheDocument();
});

it("A: blocks the form and offers registration when the citizen has no household", async () => {
  mockCheck.mockResolvedValue({ kind: "not-registered" });
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-required")).toBeInTheDocument();
  expect(screen.getByText("gate.title")).toBeInTheDocument();
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
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
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
  expect(mockCheck).toHaveBeenCalledTimes(2);
});

it("E: offline with a confirmed registration, the form opens and says why", async () => {
  mockCheck.mockResolvedValue({ ...REGISTERED, source: "cached" });
  render(<IdentityStep />);
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
  expect(screen.getByText("offlineConfirmed")).toBeInTheDocument();
});
