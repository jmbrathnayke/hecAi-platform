import { signOutCitizen } from "@/lib/citizenSession";
import { getOrCreateDraftId, getDraftId } from "@/lib/draft";
import { readConfirmedRegistration, rememberRegistration } from "@/lib/registrationState";

const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: (...a: unknown[]) => mockSignOut(...a) } }),
}));
jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("ends the Supabase session and leaves nothing of this family on a shared phone", async () => {
  rememberRegistration("account-1", "HH-2026-0004");
  getOrCreateDraftId();

  await signOutCitizen();

  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(readConfirmedRegistration("account-1")).toBeNull();
  expect(getDraftId()).toBeNull();
});

it("still clears local state when the network sign-out fails", async () => {
  mockSignOut.mockRejectedValue(new Error("offline"));
  rememberRegistration("account-1", "HH-2026-0004");

  await expect(signOutCitizen()).resolves.toBeUndefined();
  expect(readConfirmedRegistration("account-1")).toBeNull();
});
