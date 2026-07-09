import { act, renderHook } from "@testing-library/react";
import {
  useAdminSessionTimeout,
  WARNING_AFTER_MS,
  TIMEOUT_AFTER_MS,
} from "../useAdminSessionTimeout";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: (...a: unknown[]) => mockSignOut(...a) } }),
}));

const mockDeleteSessionValue = jest.fn();
jest.mock("@/lib/indexeddb", () => ({
  deleteSessionValue: (...a: unknown[]) => mockDeleteSessionValue(...a),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockReset();
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  mockDeleteSessionValue.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows the warning at 3h45m of inactivity (UX-DR19)", () => {
  const { result } = renderHook(() => useAdminSessionTimeout());
  expect(result.current.showWarning).toBe(false);

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS);
  });
  expect(result.current.showWarning).toBe(true);
});

test("signs out and redirects to /admin/login at 4h of inactivity", async () => {
  renderHook(() => useAdminSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockSignOut).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/admin/login");
});

test("a signOut() failure still redirects (fails closed, never strands the admin)", async () => {
  mockSignOut.mockRejectedValue(new Error("network down"));
  renderHook(() => useAdminSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockPush).toHaveBeenCalledWith("/admin/login");
});

test("clears the cached admin IDB session on forced timeout sign-out (code review 2026-07-09)", async () => {
  renderHook(() => useAdminSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockDeleteSessionValue).toHaveBeenCalledWith("admin");
});

test("cache is still cleared even when signOut() fails", async () => {
  mockSignOut.mockRejectedValue(new Error("network down"));
  renderHook(() => useAdminSessionTimeout());

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockDeleteSessionValue).toHaveBeenCalledWith("admin");
});

test("onBeforeTimeout seam (UX-DR20) fires once, before signOut, on idle expiry", async () => {
  const onBeforeTimeout = jest.fn(() => {
    // At the moment the snapshot runs, sign-out must not have happened yet.
    expect(mockSignOut).not.toHaveBeenCalled();
  });
  renderHook(() => useAdminSessionTimeout({ onBeforeTimeout }));

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onBeforeTimeout).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/admin/login");
});

test("a throwing onBeforeTimeout does not block sign-out/redirect", async () => {
  const onBeforeTimeout = jest.fn(() => {
    throw new Error("snapshot failed");
  });
  renderHook(() => useAdminSessionTimeout({ onBeforeTimeout }));

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockPush).toHaveBeenCalledWith("/admin/login");
});

test("onBeforeTimeout does NOT fire if activity resets the clock before expiry", () => {
  const onBeforeTimeout = jest.fn();
  renderHook(() => useAdminSessionTimeout({ onBeforeTimeout }));

  act(() => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS - 1000);
    window.dispatchEvent(new Event("keydown"));
  });
  act(() => {
    jest.advanceTimersByTime(1000);
  });

  expect(onBeforeTimeout).not.toHaveBeenCalled();
});

test("activity before the warning threshold resets the clock", () => {
  const { result } = renderHook(() => useAdminSessionTimeout());

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS - 1000);
    window.dispatchEvent(new Event("keydown"));
  });
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(result.current.showWarning).toBe(false);
});

test("extendSession dismisses the warning and rearms the timers", () => {
  const { result } = renderHook(() => useAdminSessionTimeout());

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS);
  });
  expect(result.current.showWarning).toBe(true);

  act(() => {
    result.current.extendSession();
  });
  expect(result.current.showWarning).toBe(false);

  act(() => {
    jest.advanceTimersByTime(WARNING_AFTER_MS - 1000);
  });
  expect(result.current.showWarning).toBe(false);
});

test("unmounting clears timers — no signOut/redirect fires after unmount", async () => {
  const { unmount } = renderHook(() => useAdminSessionTimeout());
  unmount();

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

test("activity arriving while signOut() is in flight cancels the stale redirect (generation guard)", async () => {
  let resolveSignOut: (v: { error: null }) => void = () => {};
  mockSignOut.mockReturnValue(
    new Promise((resolve) => {
      resolveSignOut = resolve;
    }),
  );

  renderHook(() => useAdminSessionTimeout());

  act(() => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
  });
  expect(mockSignOut).toHaveBeenCalledTimes(1);

  act(() => {
    window.dispatchEvent(new Event("keydown"));
  });

  await act(async () => {
    resolveSignOut({ error: null });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockPush).not.toHaveBeenCalled();
});

test("extendSession() called after unmount is a no-op — does not re-arm uncancellable timers", async () => {
  const { result, unmount } = renderHook(() => useAdminSessionTimeout());
  const { extendSession } = result.current;
  unmount();

  act(() => {
    extendSession();
  });

  await act(async () => {
    jest.advanceTimersByTime(TIMEOUT_AFTER_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});
