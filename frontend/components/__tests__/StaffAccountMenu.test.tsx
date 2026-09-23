import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StaffAccountMenu } from "@/components/StaffAccountMenu";
import { readStaffAccount, signOutStaff } from "@/lib/staffAccount";

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("@/lib/staffAccount", () => ({
  readStaffAccount: jest.fn(),
  signOutStaff: jest.fn().mockResolvedValue(undefined),
}));

const mockRead = readStaffAccount as jest.Mock;

beforeEach(() => {
  replace.mockReset();
  (signOutStaff as jest.Mock).mockClear();
  mockRead.mockReset().mockResolvedValue({
    email: "e2e-ds@hec-e2e.lk",
    role: "ds_officer",
    scope: ["ගල්නැව"],
  });
});

it("starts closed and shows who is signed in on the button", async () => {
  render(<StaffAccountMenu loginPath="/ds/login" />);
  expect(await screen.findByText("e2e-ds@hec-e2e.lk")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "account" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("staff-account-details")).not.toBeInTheDocument();
});

it("opens to the account's role and area", async () => {
  render(<StaffAccountMenu loginPath="/ds/login" />);
  await screen.findByText("e2e-ds@hec-e2e.lk");
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  const details = screen.getByTestId("staff-account-details");
  expect(details).toHaveTextContent("roles.ds_officer");
  expect(details).toHaveTextContent("scope.ds_officer");
  expect(details).toHaveTextContent("ගල්නැව");
});

it("lists every assigned division for an officer, and 'all districts' for a system admin", async () => {
  mockRead.mockResolvedValueOnce({ email: "o@x.lk", role: "officer", scope: ["ගල්නැව", "තලාව"] });
  const { unmount } = render(<StaffAccountMenu loginPath="/officer/login" />);
  await screen.findByText("o@x.lk");
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  expect(screen.getByTestId("staff-account-details")).toHaveTextContent("ගල්නැව, තලාව");
  unmount();

  mockRead.mockResolvedValueOnce({ email: "s@x.lk", role: "system_admin", scope: [] });
  render(<StaffAccountMenu loginPath="/system/login" />);
  await screen.findByText("s@x.lk");
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  expect(screen.getByTestId("staff-account-details")).toHaveTextContent("allAreas");
});

it("says 'not assigned' rather than showing an empty area", async () => {
  mockRead.mockResolvedValue({ email: "a@x.lk", role: "admin", scope: [] });
  render(<StaffAccountMenu loginPath="/admin/login" />);
  await screen.findByText("a@x.lk");
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  expect(screen.getByTestId("staff-account-details")).toHaveTextContent("notAssigned");
});

it("signs out and goes to that portal's own login page", async () => {
  render(<StaffAccountMenu loginPath="/ds/login" />);
  await screen.findByText("e2e-ds@hec-e2e.lk");
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  fireEvent.click(screen.getByText("signOut"));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/ds/login"));
  expect(signOutStaff).toHaveBeenCalledTimes(1);
});

it("closes on Escape and on a click outside", async () => {
  render(
    <div>
      <p>outside</p>
      <StaffAccountMenu loginPath="/ds/login" />
    </div>,
  );
  await screen.findByText("e2e-ds@hec-e2e.lk");
  const button = screen.getByRole("button", { name: "account" });

  fireEvent.click(button);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByTestId("staff-account-details")).not.toBeInTheDocument();

  fireEvent.click(button);
  fireEvent.mouseDown(screen.getByText("outside"));
  expect(screen.queryByTestId("staff-account-details")).not.toBeInTheDocument();
});
