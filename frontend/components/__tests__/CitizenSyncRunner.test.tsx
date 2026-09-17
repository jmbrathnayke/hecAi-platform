import { act, render } from "@testing-library/react";
import { CitizenSyncRunner } from "@/components/CitizenSyncRunner";
import { flushCitizenOutbox } from "@/lib/citizenOutbox";

jest.mock("@/lib/citizenOutbox", () => ({
  flushCitizenOutbox: jest.fn().mockResolvedValue({ attempted: 0, synced: [], failed: [] }),
}));

const mockFlush = flushCitizenOutbox as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockFlush.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

it("tries to deliver queued reports as soon as the app opens", () => {
  render(<CitizenSyncRunner />);
  expect(mockFlush).toHaveBeenCalledTimes(1);
});

it("tries again the moment the connection returns", () => {
  render(<CitizenSyncRunner />);
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  expect(mockFlush).toHaveBeenCalledTimes(2);
});

it("keeps trying on an interval as a backstop", () => {
  render(<CitizenSyncRunner intervalMs={1000} />);
  act(() => {
    jest.advanceTimersByTime(3000);
  });
  expect(mockFlush).toHaveBeenCalledTimes(4);
});

it("stops when unmounted", () => {
  const { unmount } = render(<CitizenSyncRunner intervalMs={1000} />);
  unmount();
  act(() => {
    window.dispatchEvent(new Event("online"));
    jest.advanceTimersByTime(5000);
  });
  expect(mockFlush).toHaveBeenCalledTimes(1);
});
