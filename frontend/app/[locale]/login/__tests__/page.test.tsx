/**
 * Citizen sign-in: email + password every day, the one-time email link to create an account or to
 * recover a forgotten password.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CitizenLoginPage from "@/app/[locale]/login/page";
import { createClient } from "@/lib/supabase";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));

const signInWithPassword = jest.fn();
const signInWithOtp = jest.fn();
const signUp = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: jest.fn(() => ({
    auth: {
      signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
      signInWithOtp: (...a: unknown[]) => signInWithOtp(...a),
      signUp: (...a: unknown[]) => signUp(...a),
    },
  })),
}));

beforeEach(() => {
  push.mockReset();
  (createClient as jest.Mock).mockClear();
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  signInWithOtp.mockReset().mockResolvedValue({ error: null });
  signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
});

function fillSignUp(password: string, confirm = password, email = "new@example.lk") {
  fireEvent.click(screen.getByText("createAccount"));
  fireEvent.change(screen.getByLabelText("email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("choosePassword"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("confirmPassword"), { target: { value: confirm } });
  fireEvent.click(screen.getByText("signUp"));
}

describe("creating an account with a chosen password", () => {
  it("signs the citizen straight in when the project returns a session", async () => {
    signUp.mockResolvedValue({ data: { session: { user: { id: "u-1" } } }, error: null });
    render(<CitizenLoginPage />);
    fillSignUp("correct-horse");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/my-cases"));
    expect(signUp).toHaveBeenCalledWith({ email: "new@example.lk", password: "correct-horse" });
  });

  it("asks the citizen to confirm the address when no session comes back", async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: null });
    render(<CitizenLoginPage />);
    fillSignUp("correct-horse");

    expect(await screen.findByText("confirmSent")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ["short", "short", "passwordTooShort"],
    ["correct-horse", "different-horse", "passwordMismatch"],
  ])("refuses %p / %p before calling Supabase", async (password, confirm, message) => {
    render(<CitizenLoginPage />);
    fillSignUp(password, confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("sends an existing address back to signing in, instead of a generic failure", async () => {
    signUp.mockResolvedValue({ data: {}, error: { message: "User already registered" } });
    render(<CitizenLoginPage />);
    fillSignUp("correct-horse");
    expect(await screen.findByRole("alert")).toHaveTextContent("emailTaken");
  });

  it("reports any other refusal without blaming the citizen's password", async () => {
    signUp.mockResolvedValue({ data: {}, error: { message: "Database error saving new user" } });
    render(<CitizenLoginPage />);
    fillSignUp("correct-horse");
    expect(await screen.findByRole("alert")).toHaveTextContent("signUpError");
  });
});

function fillCredentials(email = "family@example.lk", password = "correct-horse") {
  fireEvent.change(screen.getByLabelText("email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("password"), { target: { value: password } });
}

// Kept from the SMS removal (migration 034): neither way in may offer a phone or an SMS code.
it.each([
  ["password", () => {}],
  ["email link", () => fireEvent.click(screen.getByText("useLink"))],
])("citizen sign-in by %s is email only: no phone field, no SMS", (_mode, switchMode) => {
  const { container } = render(<CitizenLoginPage />);
  switchMode();
  expect(screen.getByLabelText("email")).toBeInTheDocument();
  expect(container.querySelector('input[type="tel"]')).toBeNull();
  expect(screen.queryByRole("button", { name: /sms|phone/i })).not.toBeInTheDocument();
  expect(container.textContent ?? "").not.toMatch(/sms/i);
});

it("never sends a phone number to Supabase, by either route", async () => {
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByText("signIn"));
  await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
  expect(signInWithPassword.mock.calls[0][0]).not.toHaveProperty("phone");

  fireEvent.click(screen.getByText("useLink"));
  fireEvent.change(screen.getByLabelText("email"), { target: { value: "new@example.lk" } });
  fireEvent.click(screen.getByText("sendLink"));
  await waitFor(() => expect(signInWithOtp).toHaveBeenCalled());
  expect(signInWithOtp.mock.calls[0][0]).not.toHaveProperty("phone");
});

it("signs in with a password and goes to the citizen's own cases", async () => {
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByText("signIn"));

  await waitFor(() => expect(push).toHaveBeenCalledWith("/en/my-cases"));
  expect(signInWithPassword).toHaveBeenCalledWith({
    email: "family@example.lk",
    password: "correct-horse",
  });
  expect(signInWithOtp).not.toHaveBeenCalled();
});

it("does not say WHICH of the email or password was wrong", async () => {
  signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
  render(<CitizenLoginPage />);
  fillCredentials("nobody@example.lk");
  fireEvent.click(screen.getByText("signIn"));

  // Naming the field would turn this form into a way to find out which addresses have accounts.
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("wrongCredentials");
  expect(alert.textContent).not.toMatch(/nobody@example\.lk/);
  expect(push).not.toHaveBeenCalled();
});

it("trims the email but never the password", async () => {
  render(<CitizenLoginPage />);
  fillCredentials("  family@example.lk  ", "  spaces are allowed  ");
  fireEvent.click(screen.getByText("signIn"));
  await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
  expect(signInWithPassword).toHaveBeenCalledWith({
    email: "family@example.lk",
    password: "  spaces are allowed  ",
  });
});

it("falls back to the email link, which is also what creates an account", async () => {
  render(<CitizenLoginPage />);
  fireEvent.click(screen.getByText("useLink"));

  expect(screen.queryByLabelText("password")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("email"), { target: { value: "new@example.lk" } });
  fireEvent.click(screen.getByText("sendLink"));

  expect(await screen.findByText("linkSent")).toBeInTheDocument();
  expect(signInWithOtp).toHaveBeenCalledWith({
    email: "new@example.lk",
    options: { shouldCreateUser: true },
  });
});

it("explains a link that could not be sent, and can be returned to the password form", async () => {
  signInWithOtp.mockResolvedValue({ error: { message: "over_email_send_rate_limit" } });
  render(<CitizenLoginPage />);
  fireEvent.click(screen.getByText("useLink"));
  fireEvent.change(screen.getByLabelText("email"), { target: { value: "new@example.lk" } });
  fireEvent.click(screen.getByText("sendLink"));

  expect(await screen.findByRole("alert")).toHaveTextContent("sendError");
  fireEvent.click(screen.getByText("backToPassword"));
  expect(screen.getByLabelText("password")).toBeInTheDocument();
});

it("reports a transport failure as a network problem, not a wrong password", async () => {
  signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<CitizenLoginPage />);
  fillCredentials();
  fireEvent.click(screen.getByText("signIn"));
  expect(await screen.findByRole("alert")).toHaveTextContent("networkError");
});

describe("confirming the address on another device", () => {
  const NOT_CONFIRMED = { data: { session: null }, error: { message: "Email not confirmed" } };
  const SIGNED_IN = { data: { session: { user: { id: "u-1" } } }, error: null };

  async function waitOnConfirmScreen() {
    render(<CitizenLoginPage />);
    fillSignUp("correct-horse");
    expect(await screen.findByText("confirmSent")).toBeInTheDocument();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    signInWithPassword.mockResolvedValue(NOT_CONFIRMED);
  });
  afterEach(() => jest.useRealTimers());

  it("keeps trying the new credentials and opens the dashboard once the link is opened anywhere", async () => {
    await waitOnConfirmScreen();
    expect(screen.getByTestId("confirm-note")).toHaveTextContent("confirmWaiting");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "new@example.lk", password: "correct-horse" });
    expect(push).not.toHaveBeenCalled();

    signInWithPassword.mockResolvedValue(SIGNED_IN); // confirmed on the laptop meanwhile
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(push).toHaveBeenCalledWith("/en/my-cases");
  });

  it("tries at once when the citizen comes back to this tab", async () => {
    await waitOnConfirmScreen();
    signInWithPassword.mockResolvedValue(SIGNED_IN);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(push).toHaveBeenCalledWith("/en/my-cases");
  });

  it("lets the citizen check by hand, and says so when it is not confirmed yet", async () => {
    await waitOnConfirmScreen();
    await act(async () => {
      fireEvent.click(screen.getByText("confirmCheckNow"));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("confirm-note")).toHaveTextContent("confirmStillWaiting");
    expect(push).not.toHaveBeenCalled();
  });

  it("stays inside the sign-in rate limit and stops after ten minutes", async () => {
    await waitOnConfirmScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5 * 60_000);
    });
    // Supabase allows 30 sign-ins per 5 minutes per IP; the sign-up itself was one more request.
    expect(signInWithPassword.mock.calls.length).toBeLessThanOrEqual(25);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(6 * 60_000);
    });
    expect(screen.getByTestId("confirm-note")).toHaveTextContent("confirmTimedOut");
    const total = signInWithPassword.mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(signInWithPassword.mock.calls.length).toBe(total);
  });

  it("stops trying as soon as the citizen leaves the screen", async () => {
    await waitOnConfirmScreen();
    fireEvent.click(screen.getByText("haveAccount"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
