/**
 * The notification feed client (the bell's data layer).
 *
 * Two things worth pinning beyond "it parses JSON":
 *
 *  1. **A 200 with the wrong shape is a failure, not an empty feed.** An empty bell and a broken
 *     endpoint must not look the same to someone waiting to be told their claim moved.
 *  2. **Read state must survive storage being unavailable.** localStorage throws in a private
 *     window and with site data blocked. The bell has to render either way, and the safe direction
 *     is to over-inform — show everything as unread rather than silently hide something.
 */
import {
  fetchNotifications,
  isKnownSubject,
  readLastSeenId,
  unreadCount,
  writeLastSeenId,
  type NotificationItem,
} from "@/lib/notificationFeed";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const mockFetch = jest.fn();

const item = (id: number, over: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  event: "staff_push_sent",
  subject: "case_submitted",
  canonical_id: `HEC-2026-0${id}`,
  scope: "ගල්නැව",
  created_at: "2026-09-24T10:00:00+00:00",
  ...over,
});

function respond(status: number, body: unknown) {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue("a-token");
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  window.localStorage.clear();
});

describe("fetchNotifications", () => {
  it("returns the feed and sends the bearer token", async () => {
    respond(200, { notifications: [item(91), item(90)], count: 2 });
    const result = await fetchNotifications();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(2);
      expect(result.notifications[0].canonical_id).toBe("HEC-2026-091");
    }
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer a-token");
  });

  it("never asks the server when there is no session", async () => {
    mockToken.mockResolvedValue(null);
    const result = await fetchNotifications();
    expect(result).toEqual({ ok: false, failure: { reason: "no-session" } });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("carries the server's 'no scope' reason through, as an empty but successful feed", async () => {
    // A system administrator holds no district or division claim. That is a correct empty feed,
    // not an error, and the bell must be able to tell the difference.
    respond(200, { notifications: [], count: 0, reason: "no_scope" });
    const result = await fetchNotifications();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reason).toBe("no_scope");
  });

  it.each([
    [401, "signed-out"],
    [403, "server"],
    [500, "server"],
  ])("maps HTTP %i to the %s failure", async (status, reason) => {
    respond(status, { error: "nope" });
    const result = await fetchNotifications();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe(reason);
  });

  it("treats a 200 with the wrong shape as a server failure, not an empty feed", async () => {
    respond(200, { notifications: "not-an-array" });
    const result = await fetchNotifications();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("server");
  });

  it("treats unparseable JSON as a server failure", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("unexpected token");
      },
    });
    const result = await fetchNotifications();
    expect(result.ok).toBe(false);
  });

  it("reports a dropped connection as a network failure, never throwing", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchNotifications()).resolves.toEqual({
      ok: false,
      failure: { reason: "network" },
    });
  });
});

describe("read state", () => {
  it("starts at zero, so a first visit shows everything as unread", () => {
    expect(readLastSeenId()).toBe(0);
    expect(unreadCount([item(3), item(2), item(1)], 0)).toBe(3);
  });

  it("counts only what arrived after the last read", () => {
    writeLastSeenId(2);
    expect(unreadCount([item(4), item(3), item(2), item(1)], readLastSeenId())).toBe(2);
  });

  it("only ever moves forward, so an older tab cannot resurrect handled notifications", () => {
    writeLastSeenId(10);
    writeLastSeenId(4);
    expect(readLastSeenId()).toBe(10);
  });

  it.each([["not-a-number"], ["-5"], ["0"]])(
    "ignores a corrupt stored value (%s) instead of breaking the badge",
    (stored) => {
      window.localStorage.setItem("hec-notifications-last-seen", stored);
      expect(readLastSeenId()).toBe(0);
    },
  );

  it("survives storage being unavailable, showing everything as unread", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied");
    });
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied");
    });

    expect(readLastSeenId()).toBe(0);
    expect(() => writeLastSeenId(5)).not.toThrow();
    expect(unreadCount([item(1)], readLastSeenId())).toBe(1);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("isKnownSubject", () => {
  it.each(["case_submitted", "payment_pending", "Approved", "Payment Processed"])(
    "recognises %s",
    (subject) => expect(isKnownSubject(subject)).toBe(true),
  );

  it("falls back for a subject the frontend has no label for yet", () => {
    // A new server-side alert should appear in the bell immediately, showing its raw key, rather
    // than vanishing until the translations catch up.
    expect(isKnownSubject("some_future_alert")).toBe(false);
    expect(isKnownSubject(null)).toBe(false);
  });
});
