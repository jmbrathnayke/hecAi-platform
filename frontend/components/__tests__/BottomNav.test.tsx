import { render, screen, waitFor } from "@testing-library/react";
import { CitizenBottomNav } from "@/components/CitizenBottomNav";
import { OfficerBottomNav } from "@/components/OfficerBottomNav";
import { usePathname as useCitizenPathname } from "@/navigation";
import { usePathname as useOfficerPathname } from "next/navigation";
import { getQueuedItems } from "@/lib/syncQueue";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Locale-aware navigation (citizen tree) -- usePathname here returns the path WITHOUT the
// locale prefix, which is exactly why CitizenBottomNav can compare against "/my-cases".
jest.mock("@/navigation", () => ({
  usePathname: jest.fn(),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
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

jest.mock("@/lib/syncQueue", () => ({
  getQueuedItems: jest.fn(),
}));

const mockCitizenPathname = useCitizenPathname as jest.Mock;
const mockOfficerPathname = useOfficerPathname as jest.Mock;
const mockGetQueuedItems = getQueuedItems as jest.Mock;

describe("CitizenBottomNav", () => {
  afterEach(() => jest.clearAllMocks());

  it("links every citizen destination and marks the active one", () => {
    mockCitizenPathname.mockReturnValue("/my-cases");
    render(<CitizenBottomNav />);

    expect(screen.getByRole("link", { name: /navHome/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /navMyClaims/ })).toHaveAttribute("href", "/my-cases");
    expect(screen.getByRole("link", { name: /navStatus/ })).toHaveAttribute("href", "/status");

    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/my-cases");
  });

  it("matches Home EXACTLY, so it is not active on every route", () => {
    // "/" is a prefix of every path -- a startsWith match would light Home up everywhere.
    mockCitizenPathname.mockReturnValue("/status");
    render(<CitizenBottomNav />);
    expect(screen.getByRole("link", { name: /navHome/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /navStatus/ })).toHaveAttribute("aria-current", "page");
  });

  it("is hidden on login and on the terminal PoC receipt", () => {
    for (const path of ["/login", "/report/poc"]) {
      const { unmount } = (() => {
        mockCitizenPathname.mockReturnValue(path);
        return render(<CitizenBottomNav />);
      })();
      expect(screen.queryByTestId("bottom-nav")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("stays visible during the rest of the report wizard", () => {
    mockCitizenPathname.mockReturnValue("/report/photos");
    render(<CitizenBottomNav />);
    expect(screen.getByTestId("bottom-nav")).toBeInTheDocument();
  });
});

describe("OfficerBottomNav", () => {
  beforeEach(() => mockGetQueuedItems.mockResolvedValue([]));
  afterEach(() => jest.clearAllMocks());

  it("links every officer destination and marks the active one", async () => {
    mockOfficerPathname.mockReturnValue("/officer/classify");
    render(<OfficerBottomNav />);

    expect(screen.getByRole("link", { name: /navDashboard/ })).toHaveAttribute(
      "href",
      "/officer/dashboard",
    );
    expect(screen.getByRole("link", { name: /navQueue/ })).toHaveAttribute("href", "/officer/sync");

    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/officer/classify");
    await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalled());
  });

  it("badges the Queue tab with the number of outstanding items", async () => {
    mockOfficerPathname.mockReturnValue("/officer/dashboard");
    mockGetQueuedItems.mockResolvedValue([
      { status: "pending" },
      { status: "failed" },
      { status: "in_progress" },
    ]);
    render(<OfficerBottomNav />);
    expect(await screen.findByText("3")).toBeInTheDocument();
  });

  it("shows no badge when the queue is empty, rather than a '0'", async () => {
    mockOfficerPathname.mockReturnValue("/officer/dashboard");
    render(<OfficerBottomNav />);
    await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalled());
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("survives a queue read failure without breaking the bar", async () => {
    mockOfficerPathname.mockReturnValue("/officer/dashboard");
    mockGetQueuedItems.mockRejectedValue(new Error("idb unavailable"));
    render(<OfficerBottomNav />);
    await waitFor(() => expect(mockGetQueuedItems).toHaveBeenCalled());
    expect(screen.getByTestId("bottom-nav")).toBeInTheDocument();
  });

  it("is hidden on login, on the terminal PoC receipt, and outside /officer", () => {
    for (const path of ["/officer/login", "/officer/submit/poc", "/admin/cases"]) {
      const { unmount } = (() => {
        mockOfficerPathname.mockReturnValue(path);
        return render(<OfficerBottomNav />);
      })();
      expect(screen.queryByTestId("bottom-nav")).not.toBeInTheDocument();
      unmount();
    }
  });
});
