import { changeOwnPassword, MIN_PASSWORD_LENGTH } from "@/lib/password";

const mockUpdateUser = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { updateUser: (...a: unknown[]) => mockUpdateUser(...a) } }),
}));

beforeEach(() => mockUpdateUser.mockReset());

it("sets only the password, never a role or an area", async () => {
  mockUpdateUser.mockResolvedValue({ error: null });
  await expect(changeOwnPassword("new-secret-1")).resolves.toBe("ok");
  expect(mockUpdateUser).toHaveBeenCalledWith({ password: "new-secret-1" });
});

it("reports a refusal or a transport failure instead of throwing", async () => {
  mockUpdateUser.mockResolvedValueOnce({ error: { message: "reauthentication_needed" } });
  await expect(changeOwnPassword("new-secret-1")).resolves.toBe("error");

  mockUpdateUser.mockRejectedValueOnce(new Error("offline"));
  await expect(changeOwnPassword("new-secret-1")).resolves.toBe("error");
});

it("asks for more than Supabase's own 6-character floor", () => {
  expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
});
