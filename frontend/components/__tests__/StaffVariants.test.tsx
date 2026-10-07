/**
 * The opt-in variants added for the admin redesign (2026-10-07). Each one is used by the staff
 * top bars only, so the tests pin both halves: the new look renders when asked for, and the
 * citizen default is unchanged when it is not.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleButtonGroup } from "@/components/LocaleButtonGroup";
import PushNotificationToggle from "@/components/PushNotificationToggle";
import { StaffAccountMenu } from "@/components/StaffAccountMenu";
import config from "@/tailwind.config";
import { AXIS_COLOR, GRID_COLOR } from "@/components/admin/charts/chartColors";
import { getExistingSubscription, subscribeToPush } from "@/lib/push";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("@/lib/staffAccount", () => ({
  readStaffAccount: jest.fn().mockResolvedValue({
    email: "e2e-admin@hec-e2e.lk", role: "admin", scope: ["අනුරාධපුරය"], canChangePassword: false,
  }),
  signOutStaff: jest.fn(),
}));
jest.mock("@/lib/push", () => ({
  isPushSupported: () => true,
  getVapidKey: jest.fn().mockResolvedValue("vapid-key"),
  getExistingSubscription: jest.fn(),
  subscribeToPush: jest.fn(),
  unsubscribeFromPush: jest.fn(),
}));

beforeEach(() => {
  (getExistingSubscription as jest.Mock).mockReset().mockResolvedValue(null);
  (subscribeToPush as jest.Mock).mockReset().mockResolvedValue("subscribed");
});

describe("LocaleButtonGroup", () => {
  it("keeps three separate full-height buttons by default (the citizen selector)", () => {
    render(<LocaleButtonGroup current="si" onSelect={() => {}} />);
    const si = screen.getByRole("button", { name: "සිංහල" });
    expect(si).toHaveAttribute("aria-pressed", "true");
    expect(si.className).toContain("min-h-touch-target");
  });

  it("joins the buttons into one segmented control when asked, still reporting which is active", () => {
    const onSelect = jest.fn();
    render(<LocaleButtonGroup current="en" onSelect={onSelect} segmented />);
    expect(screen.getByRole("group", { name: "Language selection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "தமிழ்" }));
    expect(onSelect).toHaveBeenCalledWith("ta");
  });
});

describe("PushNotificationToggle", () => {
  it("is still a standalone card with a button by default", async () => {
    render(<PushNotificationToggle variant="staff" />);
    expect(await screen.findByRole("button", { name: "enable" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("becomes a labelled switch row for the account menu", async () => {
    render(<PushNotificationToggle variant="staff" layout="row" />);
    const toggle = await screen.findByRole("switch", { name: "title" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(subscribeToPush).toHaveBeenCalledTimes(1);
  });
});

describe("StaffAccountMenu", () => {
  it("shows initials instead of an emoji, and no notification switch unless asked", async () => {
    render(<StaffAccountMenu loginPath="/ds/login" />);
    expect(await screen.findByText("EA")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "account" }));
    expect(screen.queryByTestId("push-toggle-row")).not.toBeInTheDocument();
  });

  it("carries this device's notification switch when the admin shell asks for it", async () => {
    render(<StaffAccountMenu loginPath="/admin/login" showPushToggle />);
    await screen.findByText("EA");
    fireEvent.click(screen.getByRole("button", { name: "account" }));
    expect(await screen.findByTestId("push-toggle-row")).toBeInTheDocument();
  });
});

describe("chart neutrals", () => {
  it("match the colour tokens they name", () => {
    const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string>;
    expect(AXIS_COLOR.toLowerCase()).toBe(colors["ink-secondary"].toLowerCase());
    expect(GRID_COLOR.toLowerCase()).toBe(colors["border-subtle"].toLowerCase());
  });
});
