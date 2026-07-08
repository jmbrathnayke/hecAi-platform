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
