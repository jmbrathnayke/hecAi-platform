import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CitizenLoginPage from "../page";

// next-intl: passthrough translator (key -> key) + fixed locale.
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

const mockSignInWithPassword = jest.fn();
const mockSignUp = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a),
      signUp: (...a: unknown[]) => mockSignUp(...a),
    },
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithPassword.mockReset().mockResolvedValue({ error: null });
  mockSignUp.mockReset().mockResolvedValue({ error: null });
});

function fillCredentials() {
  fireEvent.change(screen.getByLabelText("email"), { target: { value: "c@example.com" } });
  fireEvent.change(screen.getByLabelText("password"), { target: { value: "hunter2" } });
}

test("successful sign-in redirects to the localized My Cases page", async () => {
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByRole("button", { name: "signIn" }));

  await waitFor(() =>
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "c@example.com",
      password: "hunter2",
    }),
  );
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/en/my-cases"));
});

test("sign-in failure shows an error and does not redirect", async () => {
  mockSignInWithPassword.mockResolvedValue({ error: { message: "bad" } });
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByRole("button", { name: "signIn" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("signInError");
  expect(mockPush).not.toHaveBeenCalled();
});

test("sign-up shows the confirm-email notice and does not redirect", async () => {
  render(<CitizenLoginPage />);
  // toggle to sign-up mode
  fireEvent.click(screen.getByRole("button", { name: "toggleToSignUp" }));
  fillCredentials();
  fireEvent.click(screen.getByRole("button", { name: "signUp" }));

  expect(await screen.findByRole("status")).toHaveTextContent("checkEmail");
  await waitFor(() => expect(mockSignUp).toHaveBeenCalled());
  expect(mockPush).not.toHaveBeenCalled();
});

test("a thrown network failure shows a generic error", async () => {
  mockSignInWithPassword.mockRejectedValue(new Error("network down"));
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByRole("button", { name: "signIn" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("networkError");
});
