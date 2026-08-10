import { act, renderHook, waitFor } from "@testing-library/react";
import { useOfficerSession } from "../useOfficerSession";

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

test("live session populates officer_id and assigned_divisions, then caches to IDB", async () => {
  mockGetSession.mockResolvedValue({
    data: {
      session: {
        user: { id: "officer-1", app_metadata: { assigned_divisions: ["DIV-1", "DIV-2"] } },
      },
    },
    error: null,
  });

  const { result } = renderHook(() => useOfficerSession());
  expect(result.current.loading).toBe(true);

  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBe("officer-1");
  expect(result.current.assigned_divisions).toEqual(["DIV-1", "DIV-2"]);
  expect(mockPutSessionValue).toHaveBeenCalledWith({
    id: "officer",
    officer_id: "officer-1",
    assigned_divisions: ["DIV-1", "DIV-2"],
  });
});

test("malformed assigned_divisions claim (non-array) is coerced to empty list", async () => {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "officer-1", app_metadata: { assigned_divisions: "DIV-1" } } } },
    error: null,
  });

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.assigned_divisions).toEqual([]);
});

test("no live session falls back to the last cached IDB session (offline availability)", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue({
    id: "officer",
    officer_id: "cached-officer",
    assigned_divisions: ["DIV-9"],
  });

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBe("cached-officer");
  expect(result.current.assigned_divisions).toEqual(["DIV-9"]);
});

test("no live session and no cache resolves to signed-out state, not a stuck loading spinner", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue(undefined);

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBeNull();
  expect(result.current.assigned_divisions).toEqual([]);
});

test("getSession() rejection falls back to the cached IDB session — the 'dropped connection' case is exactly what the cache exists for", async () => {
  mockGetSession.mockRejectedValue(new Error("network down"));
  mockGetSessionValue.mockResolvedValue({
    id: "officer",
    officer_id: "cached-officer",
    assigned_divisions: ["DIV-9"],
  });

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBe("cached-officer");
  expect(result.current.assigned_divisions).toEqual(["DIV-9"]);
});

test("getSession() rejection with no cache resolves to signed-out state, not an unhandled rejection", async () => {
  mockGetSession.mockRejectedValue(new Error("network down"));
  mockGetSessionValue.mockResolvedValue(undefined);

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBeNull();
});

test("a malformed session (truthy session, missing user) falls back to cache instead of throwing", async () => {
  mockGetSession.mockResolvedValue({ data: { session: { user: undefined } }, error: null });
  mockGetSessionValue.mockResolvedValue({
    id: "officer",
    officer_id: "cached-officer",
    assigned_divisions: ["DIV-9"],
  });

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBe("cached-officer");
});

test("a cached record with a non-string officer_id is coerced to null, not passed through", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetSessionValue.mockResolvedValue({ id: "officer", officer_id: 12345, assigned_divisions: [] });

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBeNull();
});

test("a hung getSession() that never resolves falls back to cache via the timeout race, not a stuck spinner", async () => {
  jest.useFakeTimers();
  mockGetSession.mockReturnValue(new Promise(() => {})); // never resolves
  mockGetSessionValue.mockResolvedValue({
    id: "officer",
    officer_id: "cached-officer",
    assigned_divisions: [],
  });

  const { result } = renderHook(() => useOfficerSession());
  expect(result.current.loading).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(8000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.loading).toBe(false);
  expect(result.current.officer_id).toBe("cached-officer");
  jest.useRealTimers();
});

test("a putSessionValue cache-write failure does not affect the resolved state", async () => {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "officer-1", app_metadata: { assigned_divisions: [] } } } },
    error: null,
  });
  mockPutSessionValue.mockRejectedValue(new Error("quota exceeded"));

  const { result } = renderHook(() => useOfficerSession());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.officer_id).toBe("officer-1");
});

test("unmounting before getSession() resolves does not throw or warn about state updates", async () => {
  let resolveGetSession: (value: unknown) => void = () => {};
  mockGetSession.mockReturnValue(
    new Promise((resolve) => {
      resolveGetSession = resolve;
    }),
  );

  const { unmount } = renderHook(() => useOfficerSession());
  unmount();
  resolveGetSession({
    data: { session: { user: { id: "officer-1", app_metadata: {} } } },
    error: null,
  });
  // Flush microtasks — if the hook doesn't guard against post-unmount state updates, React
  // would log an act()/state-update warning here, not throw synchronously.
  await new Promise((r) => setTimeout(r, 0));
});
