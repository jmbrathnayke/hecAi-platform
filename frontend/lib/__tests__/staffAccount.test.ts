import { accountFromMetadata, changeStaffPassword, readStaffAccount, signOutStaff } from "@/lib/staffAccount";
import { deleteSessionValue } from "@/lib/indexeddb";

const mockSignOut = jest.fn();
const mockGetSession = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({
    auth: {
      signOut: (...a: unknown[]) => mockSignOut(...a),
      getSession: (...a: unknown[]) => mockGetSession(...a),
      updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    },
  }),
}));
jest.mock("@/lib/indexeddb", () => ({ deleteSessionValue: jest.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  mockGetSession.mockReset();
  (deleteSessionValue as jest.Mock).mockClear();
});

describe("accountFromMetadata", () => {
  it.each([
    [{ role: "officer", assigned_divisions: ["ගල්නැව", 7, "තලාව"] }, "officer", ["ගල්නැව", "තලාව"]],
    [{ role: "admin", district_id: "අනුරාධපුරය" }, "admin", ["අනුරාධපුරය"]],
    [{ role: "ds_officer", ds_division: "ගල්නැව" }, "ds_officer", ["ගල්නැව"]],
    [{ role: "system_admin" }, "system_admin", []],
  ])("reads the scope that belongs to the role (%j)", (meta, role, scope) => {
    expect(accountFromMetadata("x@y.lk", meta)).toEqual({ email: "x@y.lk", role, scope, canChangePassword: false });
  });

  it("does not show a scope claim that belongs to a different role", () => {
    expect(accountFromMetadata(null, { role: "admin", ds_division: "ගල්නැව" }).scope).toEqual([]);
  });

  it("treats an unknown or missing role as no role", () => {
    expect(accountFromMetadata(null, { role: "superuser" }).role).toBeNull();
    expect(accountFromMetadata(null, {}).role).toBeNull();
  });
});

it("reads the account from the session, or null when there is none", async () => {
  mockGetSession.mockResolvedValueOnce({
    data: { session: { user: { email: "e2e-admin@hec-e2e.lk", app_metadata: { role: "admin", district_id: "අනුරාධපුරය" } } } },
  });
  await expect(readStaffAccount()).resolves.toEqual({
    email: "e2e-admin@hec-e2e.lk",
    role: "admin",
    scope: ["අනුරාධපුරය"],
    canChangePassword: false,
  });

  mockGetSession.mockResolvedValueOnce({ data: { session: null } });
  await expect(readStaffAccount()).resolves.toBeNull();
});

it("signs out and clears the cached officer and admin sessions", async () => {
  await signOutStaff();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(deleteSessionValue).toHaveBeenCalledWith("officer");
  expect(deleteSessionValue).toHaveBeenCalledWith("admin");
});

it("still clears the caches when the network sign-out fails", async () => {
  mockSignOut.mockRejectedValue(new Error("offline"));
  await expect(signOutStaff()).resolves.toBeUndefined();
  expect(deleteSessionValue).toHaveBeenCalledTimes(2);
});

describe("password change", () => {
  it("is offered to password accounts, not to Google-only ones", () => {
    expect(accountFromMetadata(null, { role: "admin", providers: ["email"] }).canChangePassword).toBe(true);
    expect(accountFromMetadata(null, { role: "admin", providers: ["google", "email"] }).canChangePassword).toBe(true);
    expect(accountFromMetadata(null, { role: "admin", providers: ["google"] }).canChangePassword).toBe(false);
  });

  it("sets only the password, and reports failure instead of throwing", async () => {
    mockUpdateUser.mockResolvedValueOnce({ error: null });
    await expect(changeStaffPassword("new-secret-1")).resolves.toBe("ok");
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: "new-secret-1" });

    mockUpdateUser.mockResolvedValueOnce({ error: { message: "reauthentication_needed" } });
    await expect(changeStaffPassword("new-secret-1")).resolves.toBe("error");

    mockUpdateUser.mockRejectedValueOnce(new Error("offline"));
    await expect(changeStaffPassword("new-secret-1")).resolves.toBe("error");
  });
});
