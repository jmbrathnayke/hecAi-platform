import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficerProfilePage from "@/app/officer/profile/page";
import { readStaffAccount, signOutStaff } from "@/lib/staffAccount";
import { getQueuedItems } from "@/lib/syncQueue";

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
}));
jest.mock("next/link", () => {
  const Link = ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});
jest.mock("@/lib/staffAccount", () => ({
  readStaffAccount: jest.fn(),
  signOutStaff: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/syncQueue", () => ({ getQueuedItems: jest.fn() }));

const mockQueue = getQueuedItems as jest.Mock;

beforeEach(() => {
  replace.mockReset();
  (signOutStaff as jest.Mock).mockClear();
  (readStaffAccount as jest.Mock).mockResolvedValue({
    email: "e2e-officer@hec-e2e.lk",
    role: "officer",
    scope: ["ගල්නැව"],
  });
  mockQueue.mockReset().mockResolvedValue([]);
});

it("shows the officer's account, role and assigned divisions", async () => {
  render(<OfficerProfilePage />);
  const details = await screen.findByTestId("staff-account-details");
  await waitFor(() => expect(details).toHaveTextContent("e2e-officer@hec-e2e.lk"));
  expect(details).toHaveTextContent("roles.officer");
  expect(details).toHaveTextContent("ගල්නැව");
});

it("with nothing queued, signs straight out to the officer login", async () => {
  render(<OfficerProfilePage />);
  await screen.findByText("e2e-officer@hec-e2e.lk");
  fireEvent.click(screen.getByText("signOut"));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/officer/login"));
  expect(signOutStaff).toHaveBeenCalledTimes(1);
});

it("with reports still queued, warns and asks before signing out", async () => {
  mockQueue.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  render(<OfficerProfilePage />);

  const warning = await screen.findByTestId("pending-sync-warning");
  expect(warning).toHaveTextContent('pendingSync:{"count":2}');
  expect(screen.getByRole("link", { name: "goToSync" })).toHaveAttribute("href", "/officer/sync");

  fireEvent.click(screen.getByText("signOut"));
  expect(signOutStaff).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("cancel"));
  expect(screen.getByText("signOut")).toBeInTheDocument();

  fireEvent.click(screen.getByText("signOut"));
  fireEvent.click(screen.getByText("signOutAnyway"));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/officer/login"));
  expect(signOutStaff).toHaveBeenCalledTimes(1);
});
