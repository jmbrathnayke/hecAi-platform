import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CompensationCapsPage from "../page";
import { fetchCompensationCaps, updateCompensationCap } from "@/lib/adminSettings";
import { getAccessToken } from "@/lib/auth";

const ANURADHAPURA = "අනුරාධපුරය"; // real top-level key in public/data/district_reference.json

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a) }),
}));

const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      getUser: (...a: unknown[]) => mockGetUser(...a),
      signOut: (...a: unknown[]) => mockSignOut(...a),
    },
  }),
}));

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminSettings", () => ({
  fetchCompensationCaps: jest.fn(),
  updateCompensationCap: jest.fn(),
  UNAUTHORIZED: "unauthorized",
}));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFetchCaps = fetchCompensationCaps as jest.Mock;
const mockUpdateCap = updateCompensationCap as jest.Mock;

beforeEach(() => {
  mockReplace.mockReset();
  mockGetUser.mockReset().mockResolvedValue({
    data: { user: { user_metadata: { role: "admin" } } },
    error: null,
  });
  mockSignOut.mockReset();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockFetchCaps.mockReset().mockResolvedValue([
    { district: ANURADHAPURA, damage_type: "property", cap_amount_lkr: 50000, updated_by: "admin-1", updated_at: "2026-07-14T09:00:00.000Z" },
  ]);
  mockUpdateCap.mockReset();
});

test("non-admin is signed out and redirected to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "officer" } } }, error: null });
  render(<CompensationCapsPage />);
  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("renders a known district with its existing cap prefilled", async () => {
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`Property damage cap for ${ANURADHAPURA}`) as HTMLInputElement;
  expect(input.value).toBe("50000");
});

test("shows 'no cap enforced' placeholder for a district with no cap row", async () => {
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`Property damage cap for ${ANURADHAPURA}`);
  // Any other real district (not Anuradhapura) should have no existing row and show the
  // placeholder instead of a prefilled value.
  const allInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  const uncapped = allInputs.find((el) => el !== input);
  expect(uncapped?.value).toBe("");
  expect(uncapped?.placeholder).toBe("no cap enforced");
});

test("editing and saving a cap calls updateCompensationCap and reflects the saved value", async () => {
  mockUpdateCap.mockResolvedValue({
    district: ANURADHAPURA, damage_type: "property", cap_amount_lkr: 75000,
    updated_by: "admin-1", updated_at: "2026-07-14T10:00:00.000Z",
  });
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`Property damage cap for ${ANURADHAPURA}`);
  fireEvent.change(input, { target: { value: "75000" } });

  const row = input.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(mockUpdateCap).toHaveBeenCalledWith("tok-123", ANURADHAPURA, 75000),
  );
});

test("a 401/403 from fetchCompensationCaps redirects to /admin/login", async () => {
  mockFetchCaps.mockResolvedValue("unauthorized");
  render(<CompensationCapsPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a 401/403 from updateCompensationCap redirects to /admin/login", async () => {
  mockUpdateCap.mockResolvedValue("unauthorized");
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`Property damage cap for ${ANURADHAPURA}`);
  fireEvent.change(input, { target: { value: "60000" } });
  const row = input.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /save/i }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});
