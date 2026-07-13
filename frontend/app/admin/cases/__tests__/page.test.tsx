import { render, screen, waitFor } from "@testing-library/react";
import AdminCasesPlaceholderPage from "../page";

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

beforeEach(() => {
  mockReplace.mockReset();
  mockGetUser.mockReset();
  mockSignOut.mockReset().mockResolvedValue({ error: null });
});

test("an admin user sees the placeholder page (code review 2026-07-09 role gate)", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "admin" } } }, error: null });
  render(<AdminCasesPlaceholderPage />);

  expect(await screen.findByText(/case list coming in story 5.3/i)).toBeInTheDocument();
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

test("a non-admin (e.g. Google OAuth officer/citizen) is signed out and redirected to /admin/login", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "officer" } } }, error: null });
  render(<AdminCasesPlaceholderPage />);

  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockReplace).toHaveBeenCalledWith("/admin/login");
  expect(screen.queryByText(/case list coming in story 5.3/i)).not.toBeInTheDocument();
});

test("no role metadata at all is refused and redirected", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null });
  render(<AdminCasesPlaceholderPage />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("getUser() error fails closed — redirected, not rendered", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid session" } });
  render(<AdminCasesPlaceholderPage />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a thrown network failure during getUser() fails closed — redirected", async () => {
  mockGetUser.mockRejectedValue(new Error("network down"));
  render(<AdminCasesPlaceholderPage />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("a signOut() failure still redirects (fails closed, never strands a non-admin on the page)", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { user_metadata: { role: "citizen" } } }, error: null });
  mockSignOut.mockRejectedValue(new Error("network down"));
  render(<AdminCasesPlaceholderPage />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
});

test("unmounting before getUser() resolves does not throw or update state", async () => {
  let resolveGetUser: (value: unknown) => void = () => {};
  mockGetUser.mockReturnValue(
    new Promise((resolve) => {
      resolveGetUser = resolve;
    }),
  );

  const { unmount } = render(<AdminCasesPlaceholderPage />);
  unmount();
  resolveGetUser({ data: { user: { user_metadata: { role: "admin" } } }, error: null });
  await new Promise((r) => setTimeout(r, 0));

  expect(mockReplace).not.toHaveBeenCalled();
});
