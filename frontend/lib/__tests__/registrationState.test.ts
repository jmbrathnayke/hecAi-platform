import {
  REGISTRATION_CACHE_KEY,
  accountIdFromToken,
  checkRegistration,
  readConfirmedRegistration,
  rememberRegistration,
} from "@/lib/registrationState";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;

function tokenFor(sub: string): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub, app_metadata: {} })}.sig`;
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
}

function respond(status: number, body: unknown = {}) {
  (global.fetch as jest.Mock).mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  window.localStorage.clear();
  mockToken.mockReset().mockResolvedValue(tokenFor("account-1"));
  global.fetch = jest.fn();
  setOnline(true);
});

describe("checkRegistration", () => {
  it("A: a clean 404 means not registered", async () => {
    respond(404, { error: "not_found" });
    await expect(checkRegistration()).resolves.toEqual({ kind: "not-registered" });
  });

  it("B: a registered household is reported with its reference and remembered", async () => {
    respond(200, { household_ref: "HH-2026-0001", district: "x", ds_division: "y", members: [] });
    await expect(checkRegistration()).resolves.toEqual({
      kind: "registered",
      householdRef: "HH-2026-0001",
      source: "server",
    });
    expect(readConfirmedRegistration("account-1")).toBe("HH-2026-0001");
  });

  it("C: no session means sign in, without asking the server", async () => {
    mockToken.mockResolvedValue(null);
    await expect(checkRegistration()).resolves.toEqual({ kind: "unauthenticated" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("C: an expired session the server rejects also means sign in", async () => {
    respond(401);
    await expect(checkRegistration()).resolves.toEqual({ kind: "unauthenticated" });
  });

  it("D: a server failure with nothing confirmed asks the citizen to retry", async () => {
    respond(503);
    await expect(checkRegistration()).resolves.toEqual({ kind: "unavailable" });
  });

  it("D: an unreachable API with nothing confirmed is NOT reported as unregistered", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(checkRegistration()).resolves.toEqual({ kind: "unavailable" });
  });

  it("E: offline, a registration confirmed earlier for this account is used", async () => {
    rememberRegistration("account-1", "HH-2026-0001");
    setOnline(false);
    await expect(checkRegistration()).resolves.toEqual({
      kind: "registered",
      householdRef: "HH-2026-0001",
      source: "cached",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("E: an unreachable API also falls back to the confirmed state", async () => {
    rememberRegistration("account-1", "HH-2026-0001");
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    const state = await checkRegistration();
    expect(state).toEqual({ kind: "registered", householdRef: "HH-2026-0001", source: "cached" });
  });

  it("E: another account's confirmation on the same phone is never used", async () => {
    rememberRegistration("someone-else", "HH-2026-0009");
    setOnline(false);
    await expect(checkRegistration()).resolves.toEqual({ kind: "unavailable" });
  });

  it("forgets a stale confirmation when the server says there is no household", async () => {
    rememberRegistration("account-1", "HH-2026-0001");
    respond(404);
    await checkRegistration();
    expect(window.localStorage.getItem(REGISTRATION_CACHE_KEY)).toBeNull();
  });

  it("stores no identity beyond the household reference and the opaque account id", async () => {
    respond(200, {
      household_ref: "HH-2026-0001",
      district: "අනුරාධපුරය",
      ds_division: "තලාව",
      members: [{ full_name: "Test Registrant", relationship: null, is_registrant: true }],
    });
    await checkRegistration();
    const stored = JSON.parse(window.localStorage.getItem(REGISTRATION_CACHE_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(["account", "confirmedAt", "householdRef", "v"]);
    expect(JSON.stringify(stored)).not.toContain("Test Registrant");
  });

  it("is unavailable, not unregistered, when auth is not configured", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(checkRegistration()).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("accountIdFromToken", () => {
  it("reads the subject and tolerates garbage", () => {
    expect(accountIdFromToken(tokenFor("abc"))).toBe("abc");
    expect(accountIdFromToken("not-a-jwt")).toBeNull();
  });
});
