import { act, fireEvent, render, screen } from "@testing-library/react";
import LocationStep from "@/app/[locale]/report/location/page";
import { getCase, putCase } from "@/lib/indexeddb";
import { getCurrentPosition } from "@/lib/geolocation";
import { getDraftId } from "@/lib/draft";

// Code review fix (Story 5.2 Acceptance Auditor finding): this page previously had zero
// test coverage at all — Task 9 asked for "location-step... tests updated for the new
// picker without breaking the existing GPS-only assertions", which presupposed tests
// already existed. This file covers both: the pre-existing GPS flow, and the new
// DistrictPicker wiring.

const replace = jest.fn();
const push = jest.fn();
// A stable object reference — the real page's GPS-detection effect depends on `[router]`,
// so a mock returning a fresh object literal on every call would re-trigger that effect
// (and re-fetch GPS) on every render, forever.
const mockRouter = { replace, push };
jest.mock("@/navigation", () => ({
  useRouter: () => mockRouter,
}));

// Identity translator: t("step2.districtLabel") -> "step2.districtLabel", used as the
// accessible label text below (mirrors the pattern in report/poc/__tests__/page.test.tsx).
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));

jest.mock("@/lib/geolocation", () => ({ getCurrentPosition: jest.fn() }));

jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn().mockResolvedValue({}),
  putCase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/draft", () => ({
  getDraftId: jest.fn(() => "draft-1"),
}));

// Leaflet-based picker is never reached when GPS resolves — mock so its dynamic import
// can't drag Leaflet into jsdom (mirrors officer/submit/__tests__/page.test.tsx).
jest.mock("@/components/MapPinPicker", () => ({
  __esModule: true,
  default: () => null,
}));

const mockGetCurrentPosition = getCurrentPosition as jest.Mock;
const mockGetCase = getCase as jest.Mock;
const mockPutCase = putCase as jest.Mock;
const mockGetDraftId = getDraftId as jest.Mock;

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
  mockGetCurrentPosition.mockReset().mockResolvedValue({ latitude: 7.29, longitude: 80.63 });
  mockGetCase.mockReset().mockResolvedValue({});
  mockPutCase.mockReset().mockResolvedValue(undefined);
  mockGetDraftId.mockReset().mockReturnValue("draft-1");
});

describe("LocationStep", () => {
  it("saves GPS coordinates and navigates on Next when no district is picked (pre-existing flow, unaffected)", async () => {
    render(<LocationStep />);
    await screen.findByText("step2.gpsDetected");
    fireEvent.click(screen.getByRole("button", { name: "step2.next" }));

    await act(async () => {});
    expect(mockPutCase).toHaveBeenCalled();
    const [record] = mockPutCase.mock.calls[0];
    expect(record.location_lat).toBe(7.29);
    expect(record.location_lng).toBe(80.63);
    expect(record.district).toBeUndefined();
    expect(record.ds_division).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/report/damage");
  });

  it("redirects back to /report when there is no draft id", async () => {
    mockGetDraftId.mockReturnValue(null);
    render(<LocationStep />);
    await act(async () => {});
    expect(replace).toHaveBeenCalledWith("/report");
  });

  it("offers no district picker: the area comes from the registered household", async () => {
    render(<LocationStep />);
    await screen.findByText("step2.gpsDetected");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the household area saved in step 1 when it saves the location", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", district: "අනුරාධපුරය", ds_division: "ගල්නැව" });
    render(<LocationStep />);
    await screen.findByText("step2.gpsDetected");
    fireEvent.click(screen.getByRole("button", { name: "step2.next" }));
    await act(async () => {});

    const [record] = mockPutCase.mock.calls[0];
    expect(record.district).toBe("අනුරාධපුරය");
    expect(record.ds_division).toBe("ගල්නැව");
    expect(record.location_lat).toBe(7.29);
  });
});
