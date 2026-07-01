import { act, renderHook } from "@testing-library/react";
import {
  useSessionTimeout,
  WARNING_AFTER_MS,
  TIMEOUT_AFTER_MS,
} from "../useSessionTimeout";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: (...a: unknown[]) => mockSignOut(...a) } }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockReset();
  mockSignOut.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows the warning at 3h45m of inactivity", () => {
  const { result } = renderHook(() => useSessionTimeout());
  expect(result.current.showWarning).toBe(false);

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS);
  });
  expect(result.current.showWarning).toBe(true);
});

test("signs out and redirects at 4h of inactivity", async () => {
  renderHook(() => useSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    // Flush the async signOut().finally() chain inside the timer callback.
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockSignOut).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/officer/login");
});

test("a signOut() failure still redirects (fails closed, never strands the officer)", async () => {
  mockSignOut.mockRejectedValue(new Error("network down"));
  renderHook(() => useSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockPush).toHaveBeenCalledWith("/officer/login");
});

test("activity before the warning threshold resets the clock", () => {
  const { result } = renderHook(() => useSessionTimeout());

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS - 1000);
    window.dispatchEvent(new Event("keydown"));
  });
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  // Had activity not reset the timer, this tick would have crossed WARNING_AFTER_MS.
  expect(result.current.showWarning).toBe(false);
});

test("extendSession dismisses the warning and rearms the timers", () => {
  const { result } = renderHook(() => useSessionTimeout());

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS);
  });
  expect(result.current.showWarning).toBe(true);

  act(() => {
    result.current.extendSession();
  });
  expect(result.current.showWarning).toBe(false);

  // A fresh WARNING_AFTER_MS window should be required again, not the old remaining time.
  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS - 1000);
  });
  expect(result.current.showWarning).toBe(false);
});

test("unmounting clears timers — no signOut/redirect fires after unmount", async () => {
  const { unmount } = renderHook(() => useSessionTimeout());
  unmount();

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});
