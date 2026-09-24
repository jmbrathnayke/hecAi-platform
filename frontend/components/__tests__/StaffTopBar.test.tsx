import { render, screen } from "@testing-library/react";
import { StaffTopBar } from "@/components/StaffTopBar";
import { usePathname } from "next/navigation";

jest.mock("next/navigation", () => ({ usePathname: jest.fn() }));
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/link", () => {
  const Link = ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});
jest.mock("@/components/StaffAccountMenu", () => ({
  StaffAccountMenu: ({ loginPath }: { loginPath: string }) => (
    <div data-testid="account-menu" data-login={loginPath} />
  ),
}));

const mockPathname = usePathname as jest.Mock;

it.each([
  ["ds", "/ds/dashboard", "/ds/login"],
  ["system", "/system/users", "/system/login"],
] as const)("gives the %s tree a top bar with its home link and account menu", (tree, home, login) => {
  mockPathname.mockReturnValue(home);
  render(<StaffTopBar tree={tree} />);
  expect(screen.getByRole("link", { name: new RegExp(`brand\\.${tree}`) })).toHaveAttribute("href", home);
  expect(screen.getByTestId("account-menu")).toHaveAttribute("data-login", login);
});

it.each([
  ["ds", "/ds/login"],
  ["system", "/system/login"],
] as const)("renders nothing on the %s login page", (tree, login) => {
  mockPathname.mockReturnValue(login);
  const { container } = render(<StaffTopBar tree={tree} />);
  expect(container).toBeEmptyDOMElement();
});
