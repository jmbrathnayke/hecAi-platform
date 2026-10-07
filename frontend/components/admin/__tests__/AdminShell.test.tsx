import { render, screen, within } from "@testing-library/react";
import { AdminShell } from "@/components/admin/AdminShell";
import { usePathname } from "next/navigation";

// next-intl passthrough (Story 6.2 convention): translator returns the key.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
}));

jest.mock("next/link", () => {
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

// The account menu has its own tests (StaffAccountMenu.test.tsx); here it only has to be mounted.
jest.mock("@/components/StaffAccountMenu", () => ({
  StaffAccountMenu: ({ loginPath, showPushToggle }: { loginPath: string; showPushToggle?: boolean }) => (
    <div data-testid="account-menu" data-login={loginPath} data-push={showPushToggle ? "yes" : "no"} />
  ),
}));

// The language switch has its own tests (LanguageSelectorCookie.test.tsx); here only its placement.
jest.mock("@/components/LanguageSelectorCookie", () => ({
  LanguageSelectorCookie: ({ segmented }: { segmented?: boolean }) => (
    <div data-testid="language-switch" data-segmented={segmented ? "yes" : "no"} />
  ),
}));

// The district chip reads the session; give it an administrator scoped to one district.
jest.mock("@/lib/staffAccount", () => ({
  readStaffAccount: jest.fn().mockResolvedValue({
    email: "admin@example.lk", role: "admin", scope: ["අනුරාධපුරය"], canChangePassword: true,
  }),
}));

const mockUsePathname = usePathname as jest.Mock;

function renderAt(pathname: string) {
  mockUsePathname.mockReturnValue(pathname);
  return render(
    <AdminShell>
      <p>page content</p>
    </AdminShell>,
  );
}

describe("AdminShell", () => {
  afterEach(() => jest.clearAllMocks());

  it("renders the nav chrome and every admin destination on a normal admin route", () => {
    renderAt("/admin/cases");

    // Two nav landmarks: the mobile destination row and the desktop sidebar. Both carry the
    // full destination set -- the mobile one is not a reduced subset.
    const navs = screen.getAllByRole("navigation", { name: "nav.aria" });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(within(nav).getByRole("link", { name: /nav\.cases/ })).toHaveAttribute(
        "href",
        "/admin/cases",
      );
      expect(within(nav).getByRole("link", { name: /nav\.analytics/ })).toHaveAttribute(
        "href",
        "/admin/analytics",
      );
      expect(within(nav).getByRole("link", { name: /nav\.settings/ })).toHaveAttribute(
        "href",
        "/admin/settings/caps",
      );
    }
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("marks only the current destination with aria-current", () => {
    renderAt("/admin/analytics");
    const current = screen.getAllByRole("link", { current: "page" });
    // One per nav (mobile row + sidebar), both pointing at Analytics.
    expect(current).toHaveLength(2);
    current.forEach((link) => expect(link).toHaveAttribute("href", "/admin/analytics"));
  });

  it("treats a nested route as being on its parent destination", () => {
    // /admin/settings/caps is itself nested; this guards the startsWith() match generally.
    renderAt("/admin/settings/caps");
    screen
      .getAllByRole("link", { current: "page" })
      .forEach((link) => expect(link).toHaveAttribute("href", "/admin/settings/caps"));
  });

  it("puts the account menu in the top bar, signing out to the admin login", () => {
    renderAt("/admin/cases");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByTestId("account-menu")).toHaveAttribute("data-login", "/admin/login");
  });

  it("carries the language switch and this device's notification switch in the top bar (redesign 2026-10-07)", () => {
    // Both used to sit in the body of every admin page, above the cases.
    renderAt("/admin/cases");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByTestId("language-switch")).toHaveAttribute("data-segmented", "yes");
    expect(within(banner).getByTestId("account-menu")).toHaveAttribute("data-push", "yes");
  });

  it("names the administrator's district next to the brand", async () => {
    renderAt("/admin/cases");
    expect(await within(screen.getByRole("banner")).findByText("අනුරාධපුරය")).toBeInTheDocument();
  });

  it("renders NO navigation on the login route", () => {
    // A visitor who is not yet authenticated must not be shown links to authorised pages.
    renderAt("/admin/login");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("renders children unchanged when the pathname is unavailable", () => {
    mockUsePathname.mockReturnValue(null);
    render(
      <AdminShell>
        <p>page content</p>
      </AdminShell>,
    );
    expect(screen.getByText("page content")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
