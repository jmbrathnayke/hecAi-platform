import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficerLoginPage from "../page";

// next-intl passthrough (Story 6.2): translator returns the key.
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
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
const mockIsAuthReachable = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a),
    },
  }),
  isAuthReachable: (...a: unknown[]) => mockIsAuthReachable(...a),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
  mockSignInWithPassword.mockReset().mockResolvedValue({ error: null });
  // Reachable by default: these tests are about sign-in behaviour, not connectivity.
  mockIsAuthReachable.mockReset().mockResolvedValue(true);
  Array.from(mockSearchParams.keys()).forEach((k) => mockSearchParams.delete(k));
});

test("Google sign-in returns to the PKCE callback route, not straight to the protected dashboard", async () => {
  // Regression: redirectTo pointed at /officer/dashboard directly. The provider comes back with a
  // `?code=` that only a server-side exchangeCodeForSession() converts into session cookies, so
  // middleware saw no session and bounced the officer back to /officer/login with the code lost.
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));

  await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
  const redirectTo = mockSignInWithOAuth.mock.calls[0][0].options.redirectTo as string;
  const url = new URL(redirectTo);
  expect(url.pathname).toBe("/auth/callback");
  expect(url.searchParams.get("next")).toBe("/officer/dashboard");
  expect(mockSignInWithOAuth).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "google" }),
  );
});

test("Google sign-in error is shown to the user", async () => {
  mockSignInWithOAuth.mockResolvedValue({ error: { message: "OAuth popup blocked" } });
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("OAuth popup blocked");
});

test("a suspected-unreachable auth service warns but still attempts the sign-in", async () => {
  // signInWithOAuth() performs no network call -- it just hands the browser to the provider
  // URL. Without the reachability preflight, an unreachable/misconfigured Supabase host sent
  // the officer to a browser-level DNS error page with no message from the app at all.
  //
  // The preflight is ADVISORY, not a gate (code review 2026-08-13): a cross-origin fetch cannot
  // distinguish a real outage from a CORS rejection or an ad-blocker, so blocking on `false`
  // would lock officers out of a perfectly healthy Supabase. Warn, then proceed.
  mockIsAuthReachable.mockResolvedValue(false);
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("login.networkError");
  await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
});

test("the sign-in button is disabled while in flight and re-enabled afterwards", async () => {
  // Asserting only the re-enabled half passed vacuously: drop `disabled={submitting}` from the
  // button entirely and `.not.toBeDisabled()` is trivially true, so the double-submit guard
  // could be deleted without turning this test red (code review 2026-08-13).
  let releaseSignIn: (value: { error: null }) => void = () => {};
  mockSignInWithOAuth.mockReturnValue(
    new Promise<{ error: null }>((resolve) => {
      releaseSignIn = resolve;
    }),
  );
  render(<OfficerLoginPage />);
  const button = screen.getByRole("button", { name: "login.google" });

  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());

  releaseSignIn({ error: null });
  await waitFor(() => expect(button).not.toBeDisabled());
});

test("a callback error in the query string is surfaced on arrival", async () => {
  // app/auth/callback/route.ts bounces OAuth failures back here with ?error=<code>. Nothing read
  // it before, so a declined Google consent screen produced a pristine login form and no
  // message -- the silent no-op the callback route exists to eliminate (code review 2026-08-13).
  mockSearchParams.set("error", "access_denied");
  render(<OfficerLoginPage />);

  expect(await screen.findByRole("alert")).toHaveTextContent("login.errorAccessDenied");
});

test("an unrecognized callback error code is not reflected back to the page", async () => {
  // ?error= is attacker-controllable -- /auth/callback is reachable with no OAuth round-trip --
  // so an arbitrary string must never become chosen words on our own login page.
  mockSearchParams.set("error", "Session expired, call IT on 077-1234567");
  render(<OfficerLoginPage />);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("login.errorProvider");
  expect(alert).not.toHaveTextContent("077-1234567");
});

test("a thrown network failure during Google sign-in shows a generic error, not an unhandled rejection", async () => {
  mockSignInWithOAuth.mockRejectedValue(new Error("network down"));
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("login.networkError");
});

test("email/password sign-in success redirects to the officer dashboard", async () => {
  render(<OfficerLoginPage />);
  fireEvent.change(screen.getByPlaceholderText("login.emailPlaceholder"), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText("login.passwordPlaceholder"), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: "login.signIn" }));

  await waitFor(() =>
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "officer@dwc.gov.lk",
      password: "hunter2",
    }),
  );
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/officer/dashboard"));
});

test("email/password sign-in failure shows the error and does not redirect", async () => {
  mockSignInWithPassword.mockResolvedValue({ error: { message: "Invalid credentials" } });
  render(<OfficerLoginPage />);
  fireEvent.change(screen.getByPlaceholderText("login.emailPlaceholder"), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText("login.passwordPlaceholder"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "login.signIn" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  expect(mockPush).not.toHaveBeenCalled();
});

test("unmounting before signInWithPassword resolves does not throw or update state", async () => {
  let resolveSignIn: (value: unknown) => void = () => {};
  mockSignInWithPassword.mockReturnValue(
    new Promise((resolve) => {
      resolveSignIn = resolve;
    }),
  );

  const { unmount } = render(<OfficerLoginPage />);
  fireEvent.change(screen.getByPlaceholderText("login.emailPlaceholder"), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText("login.passwordPlaceholder"), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: "login.signIn" }));

  unmount();
  resolveSignIn({ error: null });
  await new Promise((r) => setTimeout(r, 0));
  // No assertion beyond "did not throw" — React would warn on a post-unmount setState if the
  // component's mountedRef guard were missing (Epic 2 retro lesson).
  expect(mockPush).not.toHaveBeenCalled();
});

// ============================================================ account chooser (security)
//
// Without prompt=select_account, Google silently reuses whichever account the browser is already
// signed into and never asks. On a shared device the next officer signs in as the previous one,
// every audit_log row names the wrong person, and nothing on screen reveals it — the failure is
// invisible because it looks exactly like success. In a system whose contribution is a
// tamper-evident audit trail, that is the identity mistake that must not be possible.
test("Google sign-in always forces the account chooser", async () => {
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "login.google" }));
  await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
  const options = mockSignInWithOAuth.mock.calls[0][0].options as {
    queryParams?: Record<string, string>;
  };
  expect(options.queryParams?.prompt).toBe("select_account");
});
