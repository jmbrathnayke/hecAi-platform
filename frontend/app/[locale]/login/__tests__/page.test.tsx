import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CitizenLoginPage from "../page";

// next-intl: passthrough translator (key -> key).
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

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
  mockSignInWithOtp.mockReset().mockResolvedValue({ error: null });
  mockVerifyOtp.mockReset();
});

function enterEmailAndSend(address = "villager@example.lk") {
  fireEvent.change(screen.getByLabelText("email"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "sendLink" }));
}

test("citizen sign-in is email only: no phone field and no SMS option", () => {
  const { container } = render(<CitizenLoginPage />);
  expect(screen.getByLabelText("email")).toBeInTheDocument();
  expect(container.querySelector('input[type="tel"]')).toBeNull();
  expect(screen.queryByRole("button", { name: /sms|phone/i })).not.toBeInTheDocument();
  expect(container.textContent ?? "").not.toMatch(/sms/i);
});

test("sending calls Supabase with the email, never a phone", async () => {
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  await waitFor(() =>
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "villager@example.lk",
      options: { shouldCreateUser: true },
    }),
  );
  expect(mockSignInWithOtp.mock.calls[0][0]).not.toHaveProperty("phone");
  // No code-verification step exists: the email carries a link.
  expect(mockVerifyOtp).not.toHaveBeenCalled();
});

test("a sent link moves to the check-your-inbox phase", async () => {
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  expect(await screen.findByRole("status")).toHaveTextContent("linkSent");
  fireEvent.click(screen.getByRole("button", { name: "changeEmail" }));
  expect(screen.getByLabelText("email")).toBeInTheDocument();
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

test("a thrown network failure shows a generic error", async () => {
  mockSignInWithOtp.mockRejectedValue(new Error("network down"));
  render(<CitizenLoginPage />);
  enterEmailAndSend();
  expect(await screen.findByRole("alert")).toHaveTextContent("networkError");
});
