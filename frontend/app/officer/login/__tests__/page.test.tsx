import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficerLoginPage from "../page";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

const mockSignInWithOAuth = jest.fn();
const mockSignInWithPassword = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a),
    },
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
  mockSignInWithPassword.mockReset().mockResolvedValue({ error: null });
});

test("Google sign-in triggers signInWithOAuth with a Google provider and dashboard redirect", async () => {
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

  await waitFor(() =>
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({ redirectTo: expect.stringContaining("/officer/dashboard") }),
      }),
    ),
  );
});

test("Google sign-in error is shown to the user", async () => {
  mockSignInWithOAuth.mockResolvedValue({ error: { message: "OAuth popup blocked" } });
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("OAuth popup blocked");
});

test("a thrown network failure during Google sign-in shows a generic error, not an unhandled rejection", async () => {
  mockSignInWithOAuth.mockRejectedValue(new Error("network down"));
  render(<OfficerLoginPage />);
  fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the sign-in service/i);
});

test("email/password sign-in success redirects to the officer dashboard", async () => {
  render(<OfficerLoginPage />);
  fireEvent.change(screen.getByPlaceholderText(/dwc email address/i), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

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
  fireEvent.change(screen.getByPlaceholderText(/dwc email address/i), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

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
  fireEvent.change(screen.getByPlaceholderText(/dwc email address/i), {
    target: { value: "officer@dwc.gov.lk" },
  });
  fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

  unmount();
  resolveSignIn({ error: null });
  await new Promise((r) => setTimeout(r, 0));
  // No assertion beyond "did not throw" — React would warn on a post-unmount setState if the
  // component's mountedRef guard were missing (Epic 2 retro lesson).
  expect(mockPush).not.toHaveBeenCalled();
});
