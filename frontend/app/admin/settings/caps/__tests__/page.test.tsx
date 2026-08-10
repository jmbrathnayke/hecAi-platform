import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CompensationCapsPage from "../page";
import { fetchCompensationCaps, updateCompensationCap } from "@/lib/adminSettings";
import { getAccessToken } from "@/lib/auth";

// next-intl passthrough (Story 6.3): the caps page is now localized, so the translator returns the
// key, appending interpolation values — the aria-label becomes "caps.capAria {district}" with the
// district NAME kept canonical (data, never translated).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

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
    data: { user: { app_metadata: { role: "admin" } } },
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
  mockGetUser.mockResolvedValue({ data: { user: { app_metadata: { role: "officer" } } }, error: null });
  render(<CompensationCapsPage />);
  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("renders a known district with its existing cap prefilled", async () => {
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`caps.capAria ${ANURADHAPURA}`) as HTMLInputElement;
  expect(input.value).toBe("50000");
});

test("shows 'no cap enforced' placeholder for a district with no cap row", async () => {
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`caps.capAria ${ANURADHAPURA}`);
  // Any other real district (not Anuradhapura) should have no existing row and show the
  // placeholder instead of a prefilled value.
  const allInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  const uncapped = allInputs.find((el) => el !== input);
  expect(uncapped?.value).toBe("");
  expect(uncapped?.placeholder).toBe("caps.noCapPlaceholder");
});

test("editing and saving a cap calls updateCompensationCap and reflects the saved value", async () => {
  mockUpdateCap.mockResolvedValue({
    district: ANURADHAPURA, damage_type: "property", cap_amount_lkr: 75000,
    updated_by: "admin-1", updated_at: "2026-07-14T10:00:00.000Z",
  });
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`caps.capAria ${ANURADHAPURA}`);
  fireEvent.change(input, { target: { value: "75000" } });

  const row = input.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(mockUpdateCap).toHaveBeenCalledWith("tok-123", ANURADHAPURA, 75000),
  );
});

test("editing the input again while its own save is still in flight is not clobbered when the save resolves", async () => {
  // Code review (Story 5.6): handleSave used to unconditionally clear the pending edit once its
  // own save resolved, discarding a newer edit typed in the meantime.
  let resolveSave: (value: unknown) => void = () => {};
  mockUpdateCap.mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve;
    }),
  );
  render(<CompensationCapsPage />);
  const input = (await screen.findByLabelText(
    `caps.capAria ${ANURADHAPURA}`,
  )) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "75000" } });
  const row = input.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /save/i }));
  await waitFor(() => expect(mockUpdateCap).toHaveBeenCalledWith("tok-123", ANURADHAPURA, 75000));

  fireEvent.change(input, { target: { value: "90000" } });
  resolveSave({
    district: ANURADHAPURA, damage_type: "property", cap_amount_lkr: 75000,
    updated_by: "admin-1", updated_at: "2026-07-14T10:00:00.000Z",
  });

  await waitFor(() => expect(within(row).getByRole("button", { name: /save/i })).not.toBeDisabled());
  expect(input.value).toBe("90000");
});

test("starting a second district's save does not re-enable the first district's still-in-flight Save button", async () => {
  // Code review (Story 5.6): `saving` used to be a single district string, so starting a
  // second district's save re-enabled the first district's Save button mid-flight.
  let resolveFirst: (value: unknown) => void = () => {};
  let resolveSecond: (value: unknown) => void = () => {};
  mockUpdateCap
    .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

  render(<CompensationCapsPage />);
  const firstInput = (await screen.findByLabelText(
    `caps.capAria ${ANURADHAPURA}`,
  )) as HTMLInputElement;
  const allInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  const secondInput = allInputs.find((el) => el !== firstInput)!;

  fireEvent.change(firstInput, { target: { value: "75000" } });
  const firstRow = firstInput.closest("tr")!;
  fireEvent.click(within(firstRow).getByRole("button", { name: /save/i }));
  await waitFor(() => expect(mockUpdateCap).toHaveBeenCalledTimes(1));
  expect(within(firstRow).getByRole("button", { name: /saving/i })).toBeDisabled();

  fireEvent.change(secondInput, { target: { value: "40000" } });
  const secondRow = secondInput.closest("tr")!;
  fireEvent.click(within(secondRow).getByRole("button", { name: /save/i }));
  await waitFor(() => expect(mockUpdateCap).toHaveBeenCalledTimes(2));

  expect(within(firstRow).getByRole("button", { name: /saving/i })).toBeDisabled();

  resolveFirst({
    district: ANURADHAPURA, damage_type: "property", cap_amount_lkr: 75000,
    updated_by: "admin-1", updated_at: "2026-07-14T10:00:00.000Z",
  });
  resolveSecond(null);
});

test("a 401/403 from fetchCompensationCaps redirects to /admin/login", async () => {
  mockFetchCaps.mockResolvedValue("unauthorized");
  render(<CompensationCapsPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a 401/403 from updateCompensationCap redirects to /admin/login", async () => {
  mockUpdateCap.mockResolvedValue("unauthorized");
  render(<CompensationCapsPage />);
  const input = await screen.findByLabelText(`caps.capAria ${ANURADHAPURA}`);
  fireEvent.change(input, { target: { value: "60000" } });
  const row = input.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /save/i }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});
