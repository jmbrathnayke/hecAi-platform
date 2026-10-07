/**
 * The officer field app's top bar (redesign, 2026-10-07): brand, language switch and bell in one
 * light bar, replacing the strip that held only the bell. Not shown on the sign-in screen.
 */
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { OfficerAppBar } from "@/components/OfficerAppBar";

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
jest.mock("@/components/LanguageSelectorCookie", () => ({
  LanguageSelectorCookie: ({ segmented }: { segmented?: boolean }) => (
    <div data-testid="language-switch" data-segmented={segmented ? "yes" : "no"} />
  ),
}));
jest.mock("@/components/NotificationBell", () => ({
  __esModule: true,
  default: ({ icon }: { icon?: string }) => <div data-testid="bell" data-icon={icon} />,
}));

const mockPathname = usePathname as jest.Mock;

it("carries the brand, the language switch and the bell", () => {
  mockPathname.mockReturnValue("/officer/dashboard");
  render(<OfficerAppBar />);
  expect(screen.getByRole("link", { name: /brand\.officer/ })).toHaveAttribute("href", "/officer/dashboard");
  expect(screen.getByTestId("language-switch")).toHaveAttribute("data-segmented", "yes");
  expect(screen.getByTestId("bell")).toHaveAttribute("data-icon", "line");
});

it("is not shown on the sign-in screen", () => {
  mockPathname.mockReturnValue("/officer/login");
  const { container } = render(<OfficerAppBar />);
  expect(container).toBeEmptyDOMElement();
});
