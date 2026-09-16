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

const mockSignInWithOtp = jest.fn();
const mockVerifyOtp = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: (...a: unknown[]) => mockSignInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => mockVerifyOtp(...a),
    },
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockSignInWithOtp.mockReset().mockResolvedValue({ error: null });
  mockVerifyOtp.mockReset().mockResolvedValue({ error: null });
});

function enterPhoneAndSend(phone = "+94714790447") {
  // The form opens on the EMAIL channel, so the phone field does not exist until SMS is chosen.
  // Email is the default deliberately: SMS to Sri Lankan networks needs a sender identity
  // registered with each operator, which this project cannot obtain (§7.2), so the channel that
  // actually works is the one a citizen should meet first.
  fireEvent.click(screen.getByRole("button", { name: "usePhone" }));
  fireEvent.change(screen.getByLabelText("phone"), { target: { value: phone } });
  fireEvent.click(screen.getByRole("button", { name: "sendCode" }));
}

test("sending the code moves to the OTP phase", async () => {
  render(<CitizenLoginPage />);
  enterPhoneAndSend();
  await waitFor(() => expect(mockSignInWithOtp).toHaveBeenCalledWith({ phone: "+94714790447" }));
  // OTP phase visible
  expect(await screen.findByRole("status")).toHaveTextContent("codeSent");
  expect(screen.getByRole("button", { name: "verify" })).toBeInTheDocument();
});

test("verifying a valid code redirects to the localized My Cases page", async () => {
  render(<CitizenLoginPage />);
  enterPhoneAndSend();
  await screen.findByRole("button", { name: "verify" });
  fireEvent.change(screen.getByLabelText("code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "verify" }));

  await waitFor(() =>
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      phone: "+94714790447",
      token: "123456",
      type: "sms",
    }),
  );
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/en/my-cases"));
});

test("a send failure shows an error and stays on the phone phase", async () => {
  mockSignInWithOtp.mockResolvedValue({ error: { message: "bad number" } });
  render(<CitizenLoginPage />);
  enterPhoneAndSend();
  expect(await screen.findByRole("alert")).toHaveTextContent("sendError");
  // still on the phone phase (no OTP input)
  expect(screen.getByRole("button", { name: "sendCode" })).toBeInTheDocument();
});

test("a bad OTP shows an error and does not redirect", async () => {
  mockVerifyOtp.mockResolvedValue({ error: { message: "invalid otp" } });
  render(<CitizenLoginPage />);
  enterPhoneAndSend();
  await screen.findByRole("button", { name: "verify" });
  fireEvent.change(screen.getByLabelText("code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "verify" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("verifyError");
  expect(mockPush).not.toHaveBeenCalled();
});

test("a thrown network failure shows a generic error", async () => {
  mockSignInWithOtp.mockRejectedValue(new Error("network down"));
  render(<CitizenLoginPage />);
  enterPhoneAndSend();
  expect(await screen.findByRole("alert")).toHaveTextContent("networkError");
});

// ---------------------------------------------------------------- email channel (the default)
//
// Email is what a citizen actually meets first, and what actually works: SMS to Sri Lankan
// networks requires a sender identity registered with each operator under a registered business
// entity, which this project cannot obtain (§7.2). These tests exist because the default path was
// previously covered only by the SMS tests, which no longer exercise it at all.

function enterEmailAndSend(address = "villager@example.lk") {
  fireEvent.change(screen.getByLabelText("email"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "sendLink" }));
}

test("the form opens on the email channel, not SMS", () => {
  render(<CitizenLoginPage />);
  expect(screen.getByLabelText("email")).toBeInTheDocument();
  expect(screen.queryByLabelText("phone")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "useEmail" })).toHaveAttribute("aria-pressed", "true");
});

test("sending to an email address calls Supabase with the email, never a phone", async () => {
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  await waitFor(() =>
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "villager@example.lk",
      options: { shouldCreateUser: true },
    }),
  );
  // A body carrying both identifiers would be ambiguous to Supabase and is a real past bug shape.
  expect(mockSignInWithOtp.mock.calls[0][0]).not.toHaveProperty("phone");
});

test("the email address is trimmed before it is sent", async () => {
  render(<CitizenLoginPage />);
  enterEmailAndSend("  villager@example.lk  ");
  await waitFor(() =>
    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "villager@example.lk" }),
    ),
  );
});

test("a failed send surfaces an error and stays on the identify phase", async () => {
  mockSignInWithOtp.mockResolvedValue({ error: { message: "nope" } });
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  expect(await screen.findByRole("alert")).toHaveTextContent("sendError");
  expect(screen.getByLabelText("email")).toBeInTheDocument();
});

test("switching channels clears a stale error", async () => {
  mockSignInWithOtp.mockResolvedValue({ error: { message: "nope" } });
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "usePhone" }));
  // An error about the email send must not sit above the phone field it does not describe.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
