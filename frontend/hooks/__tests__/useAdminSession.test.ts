import { act, renderHook, waitFor } from "@testing-library/react";
import { useAdminSession } from "../useAdminSession";

const mockGetSession = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } }),
}));

const mockGetSessionValue = jest.fn();
const mockPutSessionValue = jest.fn();
jest.mock("@/lib/indexeddb", () => ({
  getSessionValue: (...a: unknown[]) => mockGetSessionValue(...a),
  putSessionValue: (...a: unknown[]) => mockPutSessionValue(...a),
}));

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetSessionValue.mockReset();
  mockPutSessionValue.mockReset().mockResolvedValue(undefined);
});

test("live session populates admin_id and district_id, then caches to IDB under the 'admin' key", async () => {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "admin-1", app_metadata: { district_id: "DIST-7" } } } },
    error: null,
  });

  const { result } = renderHook(() => useAdminSession());
  expect(result.current.loading).toBe(true);

  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBe("admin-1");
  expect(result.current.district_id).toBe("DIST-7");
  // Reuses the officer_session store but under a DISTINCT cache key so the two roles never collide.
  expect(mockPutSessionValue).toHaveBeenCalledWith({
    id: "admin",
    admin_id: "admin-1",
    district_id: "DIST-7",
  });
});

test("malformed district_id claim (non-string) is coerced to null", async () => {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "admin-1", app_metadata: { district_id: 42 } } } },
    error: null,
  });

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.district_id).toBeNull();
});

test("no live session falls back to the last cached IDB session (offline availability)", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue({ id: "admin", admin_id: "cached-admin", district_id: "DIST-9" });

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBe("cached-admin");
  expect(result.current.district_id).toBe("DIST-9");
});

test("no live session and no cache resolves to signed-out state, not a stuck loading spinner", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue(undefined);

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBeNull();
  expect(result.current.district_id).toBeNull();
});

test("getSession() rejection falls back to the cached IDB session", async () => {
  mockGetSession.mockRejectedValue(new Error("network down"));
  mockGetSessionValue.mockResolvedValue({ id: "admin", admin_id: "cached-admin", district_id: "DIST-9" });

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBe("cached-admin");
  expect(result.current.district_id).toBe("DIST-9");
});

test("getSession() rejection with no cache resolves to signed-out state, not an unhandled rejection", async () => {
  mockGetSession.mockRejectedValue(new Error("network down"));
  mockGetSessionValue.mockResolvedValue(undefined);

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBeNull();
});

test("a malformed session (truthy session, missing user) falls back to cache instead of throwing", async () => {
  mockGetSession.mockResolvedValue({ data: { session: { user: undefined } }, error: null });
  mockGetSessionValue.mockResolvedValue({ id: "admin", admin_id: "cached-admin", district_id: "DIST-9" });

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBe("cached-admin");
});

test("a cached record with a non-string admin_id is coerced to null, not passed through", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue({ id: "admin", admin_id: 12345, district_id: null });

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBeNull();
});

test("a hung getSession() that never resolves falls back to cache via the timeout race, not a stuck spinner", async () => {
  jest.useFakeTimers();
  mockGetSession.mockReturnValue(new Promise(() => {})); // never resolves
  mockGetSessionValue.mockResolvedValue({ id: "admin", admin_id: "cached-admin", district_id: null });

  const { result } = renderHook(() => useAdminSession());
  expect(result.current.loading).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(8000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.loading).toBe(false);
  expect(result.current.admin_id).toBe("cached-admin");
  jest.useRealTimers();
});

test("a putSessionValue cache-write failure does not affect the resolved state", async () => {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "admin-1", app_metadata: { district_id: "DIST-1" } } } },
    error: null,
  });
  mockPutSessionValue.mockRejectedValue(new Error("quota exceeded"));

  const { result } = renderHook(() => useAdminSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.admin_id).toBe("admin-1");
});

test("unmounting before getSession() resolves does not throw or warn about state updates", async () => {
  let resolveGetSession: (value: unknown) => void = () => {};
  mockGetSession.mockReturnValue(
    new Promise((resolve) => {
      resolveGetSession = resolve;
    }),
  );

  const { unmount } = renderHook(() => useAdminSession());
  unmount();
  resolveGetSession({
    data: { session: { user: { id: "admin-1", app_metadata: {} } } },
    error: null,
  });
  await new Promise((r) => setTimeout(r, 0));
});
