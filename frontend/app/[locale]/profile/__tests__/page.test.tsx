import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProfilePage from "@/app/[locale]/profile/page";
import { fetchMyHousehold, updateMyHousehold } from "@/lib/households";
import { signOutCitizen } from "@/lib/citizenSession";

const push = jest.fn();
const replace = jest.fn();
const mockRouter = { push, replace };
jest.mock("@/navigation", () => ({ useRouter: () => mockRouter }));

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, string>) =>
    v ? `${k}:${Object.values(v).join(",")}` : k,
}));

jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { user: { email: "family@example.lk" } } },
      }),
    },
  }),
}));

jest.mock("@/lib/households", () => ({ fetchMyHousehold: jest.fn(), updateMyHousehold: jest.fn() }));
jest.mock("@/lib/citizenSession", () => ({ signOutCitizen: jest.fn().mockResolvedValue(undefined) }));

const mockFetch = fetchMyHousehold as jest.Mock;

const HOUSEHOLD = {
  household_ref: "HH-2026-0004",
  district: "අනුරාධපුරය",
  ds_division: "ගල්නැව",
  gn_division: null,
  status: "active",
  registered_at: "2026-09-22T11:45:34Z",
  address: "No. 12, Tank Road, Galnewa",
  contact_email: "family@example.lk",
  bank_account_last4: "5678",
  members: [
    { full_name: "Kamal Silva", relationship: "self", is_registrant: true },
    { full_name: "Nimali Silva", relationship: "wife", is_registrant: false },
  ],
};

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  mockFetch.mockReset();
  (updateMyHousehold as jest.Mock).mockReset();
  (signOutCitizen as jest.Mock).mockClear();
});

it("shows the signed-in account and the registered family", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: HOUSEHOLD });
  render(<ProfilePage />);

  const card = await screen.findByTestId("profile-household");
  expect(card).toHaveTextContent("HH-2026-0004");
  expect(card).toHaveTextContent("අනුරාධපුරය / ගල්නැව");
  expect(card).toHaveTextContent("No. 12, Tank Road, Galnewa");
  expect(card).toHaveTextContent("bankAccountValue:5678");
  expect(card).toHaveTextContent("Nimali Silva");
  expect(card).toHaveTextContent("memberRegistrant");
  expect(await screen.findByText("family@example.lk", { selector: "span" })).toBeInTheDocument();
});

it("says 'not recorded' for an address a pre-migration household never gave", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: { ...HOUSEHOLD, address: null, gn_division: null } });
  render(<ProfilePage />);
  const card = await screen.findByTestId("profile-household");
  expect(card).toHaveTextContent("notRecorded");
});

it("offers registration to a signed-in citizen with no household", async () => {
  mockFetch.mockResolvedValue({ kind: "not-registered" });
  render(<ProfilePage />);
  fireEvent.click(await screen.findByText("register"));
  expect(push).toHaveBeenCalledWith("/register");
});

it("offers retry, not registration, when the profile could not be loaded", async () => {
  mockFetch.mockResolvedValueOnce({ kind: "error" }).mockResolvedValueOnce({ kind: "ok", household: HOUSEHOLD });
  render(<ProfilePage />);
  expect(await screen.findByText("loadError")).toBeInTheDocument();
  expect(screen.queryByText("register")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByTestId("profile-household")).toBeInTheDocument();
});

it("sends an expired session to sign in", async () => {
  mockFetch.mockResolvedValue({ kind: "unauthenticated" });
  render(<ProfilePage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
});

it("signs out and returns the citizen home as a guest", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: HOUSEHOLD });
  render(<ProfilePage />);
  await screen.findByTestId("profile-household");
  fireEvent.click(screen.getByText("signOut"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  expect(signOutCitizen).toHaveBeenCalledTimes(1);
});

it("edits the family's details in place and shows the saved result", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: HOUSEHOLD });
  (updateMyHousehold as jest.Mock).mockResolvedValue({
    ok: true,
    household: { ...HOUSEHOLD, address: "No. 5, Lake Road, Galnewa" },
  });
  render(<ProfilePage />);
  await screen.findByTestId("profile-household");

  fireEvent.click(screen.getByText("edit"));
  const form = screen.getByTestId("profile-edit-form");
  expect(form).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("address"), { target: { value: "No. 5, Lake Road, Galnewa" } });
  fireEvent.click(screen.getByText("save"));

  expect(await screen.findByText("saved")).toBeInTheDocument();
  expect(screen.queryByTestId("profile-edit-form")).not.toBeInTheDocument();
  expect(screen.getByTestId("profile-household")).toHaveTextContent("No. 5, Lake Road, Galnewa");
  expect(updateMyHousehold).toHaveBeenCalledWith({ address: "No. 5, Lake Road, Galnewa" });
});

it("cancelling an edit leaves the details as they were", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: HOUSEHOLD });
  render(<ProfilePage />);
  await screen.findByTestId("profile-household");
  fireEvent.click(screen.getByText("edit"));
  fireEvent.change(screen.getByLabelText("address"), { target: { value: "Something else" } });
  fireEvent.click(screen.getByText("cancel"));
  expect(screen.getByTestId("profile-household")).toHaveTextContent("No. 12, Tank Road, Galnewa");
  expect(updateMyHousehold).not.toHaveBeenCalled();
});

it("shows the mobile number as it is written locally, or 'not recorded'", async () => {
  mockFetch.mockResolvedValue({ kind: "ok", household: { ...HOUSEHOLD, contact_mobile: "+94771234567" } });
  const { unmount } = render(<ProfilePage />);
  expect(await screen.findByTestId("profile-household")).toHaveTextContent("077 123 4567");
  unmount();

  mockFetch.mockResolvedValue({ kind: "ok", household: { ...HOUSEHOLD, contact_mobile: null } });
  render(<ProfilePage />);
  const card = await screen.findByTestId("profile-household");
  expect(card).toHaveTextContent("contactMobile");
  expect(card).not.toHaveTextContent("077");
});

describe("the step-by-step guide", () => {
  it("is open for a family that has not registered yet, with all eight steps", async () => {
    mockFetch.mockResolvedValue({ kind: "not-registered" });
    render(<ProfilePage />);
    const guide = await screen.findByTestId("citizen-guide");
    expect(guide).toHaveAttribute("open");
    expect(guide).toHaveTextContent("title");
    for (let n = 1; n <= 8; n++) {
      expect(guide).toHaveTextContent(`s${n}Title`);
      expect(guide).toHaveTextContent(`s${n}Body`);
    }
  });

  it("is folded away for a registered family, so their own details come first", async () => {
    mockFetch.mockResolvedValue({ kind: "ok", household: HOUSEHOLD });
    render(<ProfilePage />);
    await screen.findByTestId("profile-household");
    expect(screen.getByTestId("citizen-guide")).not.toHaveAttribute("open");
  });

  it("waits for the profile to load rather than flashing open and shut", () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<ProfilePage />);
    expect(screen.queryByTestId("citizen-guide")).not.toBeInTheDocument();
  });
});
