import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminLoginPage from "../page";

// next-intl passthrough (Story 6.3): the admin login page is now localized, so the translator
// returns the key. Supabase-returned auth errors are still shown verbatim (asserted below).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

const mockSignInWithOAuth = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a),
      signOut: (...a: unknown[]) => mockSignOut(...a),
    },
  }),
}));

// Convenience: a successful password sign-in returning a given role in user_metadata.
function signInAs(role: string | undefined) {
  mockSignInWithPassword.mockResolvedValue({
    data: { user: { id: "u-1", user_metadata: role === undefined ? {} : { role } } },
    error: null,
  });
}

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
  mockSignInWithPassword.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  mockSignOut.mockReset().mockResolvedValue({ error: null });
});

function fillAndSubmit(email = "admin@dwc.gov.lk", password = "hunter2") {
  fireEvent.change(screen.getByPlaceholderText(/login\.emailPlaceholder/i), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText(/login\.passwordPlaceholder/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /login\.signIn/i }));
}

test("Google sign-in triggers signInWithOAuth with a Google provider and /admin/cases redirect", async () => {
  render(<AdminLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /login\.google/i }));

  await waitFor(() =>
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({ redirectTo: expect.stringContaining("/admin/cases") }),
      }),
    ),
  );
});

test("Google sign-in error is shown to the user", async () => {
  mockSignInWithOAuth.mockResolvedValue({ error: { message: "OAuth popup blocked" } });
  render(<AdminLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /login\.google/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("OAuth popup blocked");
});

test("a thrown network failure during Google sign-in shows a generic error", async () => {
  mockSignInWithOAuth.mockRejectedValue(new Error("network down"));
  render(<AdminLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /login\.google/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("login.networkError");
});

test("email/password sign-in as an admin redirects to /admin/cases", async () => {
  signInAs("admin");
  render(<AdminLoginPage />);
  fillAndSubmit();

  await waitFor(() =>
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "admin@dwc.gov.lk",
      password: "hunter2",
    }),
  );
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin/cases"));
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("a valid but NON-admin (officer) credential is refused and signed back out (CRITICAL #4)", async () => {
  signInAs("officer");
  render(<AdminLoginPage />);
  fillAndSubmit();

  expect(await screen.findByRole("alert")).toHaveTextContent("login.accessDenied");
  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockPush).not.toHaveBeenCalled();
});

test("a credential with no role metadata at all is refused and signed back out", async () => {
  signInAs(undefined);
  render(<AdminLoginPage />);
  fillAndSubmit();

  expect(await screen.findByRole("alert")).toHaveTextContent("login.accessDenied");
  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(mockPush).not.toHaveBeenCalled();
});

test("email/password sign-in failure shows the error and does not redirect or check role", async () => {
  mockSignInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: "Invalid credentials" } });
  render(<AdminLoginPage />);
  fillAndSubmit("admin@dwc.gov.lk", "wrong");

  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("unmounting before signInWithPassword resolves does not throw or update state", async () => {
  let resolveSignIn: (value: unknown) => void = () => {};
  mockSignInWithPassword.mockReturnValue(
    new Promise((resolve) => {
      resolveSignIn = resolve;
    }),
  );

  const { unmount } = render(<AdminLoginPage />);
  fillAndSubmit();

  unmount();
  resolveSignIn({ data: { user: { id: "u-1", user_metadata: { role: "admin" } } }, error: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(mockPush).not.toHaveBeenCalled();
});
