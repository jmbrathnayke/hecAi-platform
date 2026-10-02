import { FINAL_FLUSH_MS, signOutCitizen } from "@/lib/citizenSession";
import { getOrCreateDraftId, getDraftId } from "@/lib/draft";
import { readConfirmedRegistration, rememberRegistration } from "@/lib/registrationState";
import { flushCitizenOutbox } from "@/lib/citizenOutbox";
import { flushCitizenPhotos } from "@/lib/citizenPhotoOutbox";

const mockSignOut = jest.fn();
jest.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: (...a: unknown[]) => mockSignOut(...a) } }),
}));
jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/citizenOutbox", () => ({ flushCitizenOutbox: jest.fn() }));
jest.mock("@/lib/citizenPhotoOutbox", () => ({ flushCitizenPhotos: jest.fn() }));

const mockFlushOutbox = flushCitizenOutbox as jest.Mock;
const mockFlushPhotos = flushCitizenPhotos as jest.Mock;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  mockFlushOutbox.mockReset().mockResolvedValue({ attempted: 0, synced: [], failed: [] });
  mockFlushPhotos.mockReset().mockResolvedValue({ attempted: 0, uploaded: 0, rejected: 0 });
  setOnline(true);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => jest.useRealTimers());

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

it("sends waiting reports and photographs BEFORE the session ends", async () => {
  // After sign-out nothing can upload them: the outboxes need this family's token, and an officer
  // signing in on the same phone is refused by design. Order is the whole point of this test.
  const order: string[] = [];
  mockFlushOutbox.mockImplementation(async () => {
    order.push("reports");
    return { attempted: 0, synced: [], failed: [] };
  });
  mockFlushPhotos.mockImplementation(async () => {
    order.push("photos");
    return { attempted: 1, uploaded: 1, rejected: 0 };
  });
  mockSignOut.mockImplementation(async () => {
    order.push("signOut");
    return { error: null };
  });

  await signOutCitizen();

  expect(order).toEqual(["reports", "photos", "signOut"]);
  // A family pressing "Sign out" is not made to wait out an earlier failure's backoff.
  expect(mockFlushPhotos).toHaveBeenCalledWith(expect.any(Number), { force: true });
});

it("never holds the sign-out longer than the cap when the network hangs", async () => {
  jest.useFakeTimers();
  mockFlushOutbox.mockReturnValue(new Promise(() => {})); // never settles

  const done = signOutCitizen();
  await jest.advanceTimersByTimeAsync(FINAL_FLUSH_MS);
  await done;

  expect(mockSignOut).toHaveBeenCalledTimes(1);
});

it("does not try to send anything while offline", async () => {
  setOnline(false);
  await signOutCitizen();
  expect(mockFlushOutbox).not.toHaveBeenCalled();
  expect(mockFlushPhotos).not.toHaveBeenCalled();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});
