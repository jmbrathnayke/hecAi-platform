import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PasswordForm } from "@/components/PasswordForm";
import { StaffPasswordToggle } from "@/components/StaffAccountMenu";
import { changeOwnPassword } from "@/lib/password";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("@/lib/password", () => ({ MIN_PASSWORD_LENGTH: 8, changeOwnPassword: jest.fn() }));
jest.mock("@/lib/staffAccount", () => ({
  readStaffAccount: jest.fn().mockResolvedValue(null),
  signOutStaff: jest.fn(),
}));

const mockChange = changeOwnPassword as jest.Mock;

function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText("newPassword"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("confirmPassword"), { target: { value: confirm } });
  fireEvent.click(screen.getByText("save"));
}

beforeEach(() => mockChange.mockReset());

it("refuses a password shorter than 8 characters without calling Supabase", () => {
  render(<PasswordForm onDone={jest.fn()} />);
  fill("short");
  expect(screen.getByRole("alert")).toHaveTextContent("passwordTooShort");
  expect(mockChange).not.toHaveBeenCalled();
});

it("refuses two passwords that do not match", () => {
  render(<PasswordForm onDone={jest.fn()} />);
  fill("long-enough-1", "long-enough-2");
  expect(screen.getByRole("alert")).toHaveTextContent("passwordMismatch");
  expect(mockChange).not.toHaveBeenCalled();
});

it("changes the password and confirms it", async () => {
  mockChange.mockResolvedValue("ok");
  const onDone = jest.fn();
  render(<PasswordForm onDone={onDone} />);
  fill("long-enough-1");
  expect(await screen.findByText("passwordChanged")).toBeInTheDocument();
  expect(mockChange).toHaveBeenCalledWith("long-enough-1");
  fireEvent.click(screen.getByText("close"));
  expect(onDone).toHaveBeenCalled();
});

it("says what to do when Supabase refuses the change", async () => {
  mockChange.mockResolvedValue("error");
  render(<PasswordForm onDone={jest.fn()} />);
  fill("long-enough-1");
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("passwordError"));
});

it("offers the change only to accounts that sign in with a password", () => {
  const base = { email: "x@y.lk", role: "admin" as const, scope: [] };
  const { rerender } = render(<StaffPasswordToggle account={{ ...base, canChangePassword: false }} />);
  expect(screen.queryByText("changePassword")).not.toBeInTheDocument();

  rerender(<StaffPasswordToggle account={{ ...base, canChangePassword: true }} />);
  fireEvent.click(screen.getByText("changePassword"));
  expect(screen.getByTestId("password-form")).toBeInTheDocument();
});
