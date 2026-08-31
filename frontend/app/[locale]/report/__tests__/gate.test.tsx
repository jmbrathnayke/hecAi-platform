/**
 * Story 8.4 — the FR-10.3 registration gate on the incident form's entrance.
 *
 * The backend already refuses an unregistered submission with 403 not_registered. What these
 * cover is the cost of finding that out: without the gate a citizen fills four steps and
 * photographs the damage before being told they cannot file.
 */
import { render, screen, waitFor } from "@testing-library/react";
import IdentityStep from "@/app/[locale]/report/page";
import { getMyHousehold } from "@/lib/households";

const push = jest.fn();
const mockRouter = { push, replace: jest.fn() };
jest.mock("@/navigation", () => ({ useRouter: () => mockRouter }));
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

jest.mock("@/lib/households", () => ({ getMyHousehold: jest.fn() }));
jest.mock("@/lib/crypto", () => ({
  getOrCreateSessionKey: jest.fn().mockResolvedValue({}),
  encryptField: jest.fn().mockResolvedValue({ ciphertext: "c", iv: "i" }),
}));
jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn().mockResolvedValue({}),
  putCase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/draft", () => ({ getOrCreateDraftId: jest.fn(() => "draft-1") }));

const mockGetMyHousehold = getMyHousehold as jest.Mock;

const HOUSEHOLD = {
  household_ref: "HH-2026-0001",
  district: "අනුරාධපුරය",
  ds_division: "තලාව",
  gn_division: null,
  status: "active",
  registered_at: null,
  members: [],
};

beforeEach(() => {
  push.mockReset();
  mockGetMyHousehold.mockReset();
});

it("shows a checking state while the registration lookup is in flight", () => {
  mockGetMyHousehold.mockReturnValue(new Promise(() => {}));  // never resolves
  render(<IdentityStep />);
  expect(screen.getByText("gate.checking")).toBeInTheDocument();
  // The form must not flash into view before we know whether it can be submitted.
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
});

it("renders the form for a registered household", async () => {
  mockGetMyHousehold.mockResolvedValue(HOUSEHOLD);
  render(<IdentityStep />);
  expect(await screen.findByLabelText("step1.nic")).toBeInTheDocument();
  expect(screen.queryByTestId("registration-required")).not.toBeInTheDocument();
});

it("blocks the form and offers registration when the citizen has no household", async () => {
  mockGetMyHousehold.mockResolvedValue(null);
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-required")).toBeInTheDocument();
  expect(screen.getByText("gate.title")).toBeInTheDocument();
  expect(screen.queryByLabelText("step1.nic")).not.toBeInTheDocument();
});

it("sends the citizen to the registration flow", async () => {
  mockGetMyHousehold.mockResolvedValue(null);
  render(<IdentityStep />);
  (await screen.findByText("gate.register")).click();
  await waitFor(() => expect(push).toHaveBeenCalledWith("/register"));
});

it("treats an unreachable API the same as no registration", async () => {
  // getMyHousehold() swallows transport failures and returns null. Letting the form open in that
  // state would send the citizen through four steps toward a submission that cannot succeed.
  mockGetMyHousehold.mockResolvedValue(null);
  render(<IdentityStep />);
  expect(await screen.findByTestId("registration-required")).toBeInTheDocument();
});
