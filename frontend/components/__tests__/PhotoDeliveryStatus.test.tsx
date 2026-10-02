/**
 * Whether the family's photographs reached the DWC. The family used to be shown a receipt and
 * nothing else, while the photographs waited on the phone for a background pass that often never
 * came -- and the officer opening the case saw none.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PhotoDeliveryStatus } from "@/components/PhotoDeliveryStatus";
import { getCase } from "@/lib/indexeddb";
import { flushCitizenPhotos } from "@/lib/citizenPhotoOutbox";

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k),
}));
jest.mock("@/lib/indexeddb", () => ({ getCase: jest.fn() }));
jest.mock("@/lib/citizenPhotoOutbox", () => {
  const actual = jest.requireActual("@/lib/citizenPhotoOutbox");
  return { ...actual, flushCitizenPhotos: jest.fn() };
});

const mockGetCase = getCase as jest.Mock;
const mockFlush = flushCitizenPhotos as jest.Mock;

function record(overrides: Record<string, unknown> = {}) {
  return {
    offline_id: "off-1",
    submission_channel: "citizen",
    canonical_id: "HEC-2026-0300",
    photo_blob_keys: ["k1", "k2"],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetCase.mockReset().mockResolvedValue(record());
  mockFlush.mockReset().mockResolvedValue({ attempted: 0, uploaded: 0, rejected: 0 });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});

it("sends the photographs as soon as the case exists, and says when they all arrived", async () => {
  mockFlush.mockImplementation(async () => {
    mockGetCase.mockResolvedValue(record({ photos_uploaded_keys: ["k1", "k2"] }));
    return { attempted: 2, uploaded: 2, rejected: 0 };
  });
  render(<PhotoDeliveryStatus offlineId="off-1" canonicalId="HEC-2026-0300" />);
  await waitFor(() => expect(screen.getByTestId("photo-delivery")).toHaveTextContent("photosSent"));
  expect(mockFlush).toHaveBeenCalledWith(expect.any(Number), { force: false });
});

it("says the photographs are still on the phone, and offers to send them now", async () => {
  mockFlush.mockResolvedValue({ attempted: 1, uploaded: 0, rejected: 0 });
  mockGetCase.mockResolvedValue(record({ photos_uploaded_keys: ["k1"] }));
  render(<PhotoDeliveryStatus offlineId="off-1" canonicalId="HEC-2026-0300" autoSend={false} />);
  expect(await screen.findByTestId("photo-delivery")).toHaveTextContent('photosWaiting {"count":1}');
  expect(mockFlush).not.toHaveBeenCalled(); // a list does not send by itself

  await act(async () => {
    fireEvent.click(screen.getByTestId("photo-delivery-send"));
  });
  // "Send now" skips the backoff of an earlier failure.
  expect(mockFlush).toHaveBeenCalledWith(expect.any(Number), { force: true });
});

it("explains that the photographs follow the report when the case is not on the server yet", async () => {
  render(<PhotoDeliveryStatus offlineId="off-1" canonicalId={null} />);
  expect(await screen.findByTestId("photo-delivery")).toHaveTextContent('photosBeforeCase {"count":2}');
  expect(mockFlush).not.toHaveBeenCalled();
  expect(screen.queryByTestId("photo-delivery-send")).not.toBeInTheDocument();
});

it("waits out a flush that the background runner already has in flight", async () => {
  jest.useFakeTimers();
  try {
    mockFlush
      .mockResolvedValueOnce({ attempted: 0, uploaded: 0, rejected: 0, skipped: "in-flight" })
      .mockResolvedValueOnce({ attempted: 2, uploaded: 2, rejected: 0 });
    render(<PhotoDeliveryStatus offlineId="off-1" canonicalId="HEC-2026-0300" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockFlush).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

it("reports photographs that will never upload", async () => {
  mockGetCase.mockResolvedValue(record({ photos_uploaded_keys: ["k1"], photos_rejected_keys: ["k2"] }));
  render(<PhotoDeliveryStatus offlineId="off-1" canonicalId="HEC-2026-0300" autoSend={false} />);
  expect(await screen.findByTestId("photo-delivery-rejected")).toHaveTextContent('photosRejected {"count":1}');
});

it("shows nothing for a report this phone did not file", async () => {
  mockGetCase.mockResolvedValue(undefined);
  const { container } = render(<PhotoDeliveryStatus offlineId="off-9" canonicalId="HEC-2026-0300" autoSend={false} />);
  await waitFor(() => expect(mockGetCase).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});
