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
const mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
  useSearchParams: () => mockSearchParams,
}));

const mockSignInWithOAuth = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockSignOut = jest.fn();
const mockIsAuthReachable = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a),
      signOut: (...a: unknown[]) => mockSignOut(...a),
    },
  }),
  isAuthReachable: (...a: unknown[]) => mockIsAuthReachable(...a),
}));

// Convenience: a successful password sign-in returning a given role in app_metadata.
function signInAs(role: string | undefined) {
  mockSignInWithPassword.mockResolvedValue({
    data: { user: { id: "u-1", app_metadata: role === undefined ? {} : { role } } },
    error: null,
  });
}

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
  mockSignInWithPassword.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  // Reachable by default: these tests are about sign-in behaviour, not connectivity.
  mockIsAuthReachable.mockReset().mockResolvedValue(true);
  Array.from(mockSearchParams.keys()).forEach((k) => mockSearchParams.delete(k));
});

function fillAndSubmit(email = "admin@dwc.gov.lk", password = "hunter2") {
  fireEvent.change(screen.getByPlaceholderText(/login\.emailPlaceholder/i), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText(/login\.passwordPlaceholder/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /login\.signIn/i }));
}

test("Google sign-in returns to the PKCE callback route, carrying /admin/cases as the destination", async () => {
  // Regression: redirectTo pointed at /admin/cases directly, so the provider's `?code=` was never
  // exchanged for session cookies and middleware bounced the admin back to /admin/login. `next`
  // preserves the original destination, so the downstream role check on /admin/cases still runs.
  render(<AdminLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /login\.google/i }));

  await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
  const redirectTo = mockSignInWithOAuth.mock.calls[0][0].options.redirectTo as string;
  const url = new URL(redirectTo);
  expect(url.pathname).toBe("/auth/callback");
  expect(url.searchParams.get("next")).toBe("/admin/cases");
  expect(mockSignInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
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
  resolveSignIn({ data: { user: { id: "u-1", app_metadata: { role: "admin" } } }, error: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(mockPush).not.toHaveBeenCalled();
});

// --- Code review 2026-08-13 ----------------------------------------------------------------

test("a suspected-unreachable auth service warns but still attempts the sign-in", async () => {
  // The reachability preflight existed on officer login only, so the failure mode it documents --
  // being handed to the browser's own "site can't be reached" page having seen nothing from the
  // app -- was still fully live for every administrator. Advisory, not a gate: a cross-origin
  // fetch cannot tell a real outage from a CORS rejection or an ad-blocker.
  mockIsAuthReachable.mockResolvedValue(false);
  render(<AdminLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("login.networkError");
  await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
});

test("a callback error in the query string is surfaced on arrival", async () => {
  mockSearchParams.set("error", "access_denied");
  render(<AdminLoginPage />);

  expect(await screen.findByRole("alert")).toHaveTextContent("login.errorAccessDenied");
});

test("an unrecognized callback error code is not reflected back to the page", async () => {
  mockSearchParams.set("error", "Session expired, call IT on 077-1234567");
  render(<AdminLoginPage />);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("login.errorProvider");
  expect(alert).not.toHaveTextContent("077-1234567");
});
