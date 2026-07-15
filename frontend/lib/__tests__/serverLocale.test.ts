import { resolveStaffLocale } from "@/lib/serverLocale";

// Mock next/headers cookies() — the source resolveStaffLocale reads NEXT_LOCALE from.
const mockGet = jest.fn();
jest.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => mockGet(name) }),
}));

beforeEach(() => mockGet.mockReset());

test("a valid NEXT_LOCALE cookie resolves to that locale", async () => {
  mockGet.mockReturnValue({ value: "ta" });
  await expect(resolveStaffLocale()).resolves.toBe("ta");
});

test("si and en cookie values are honored", async () => {
  mockGet.mockReturnValue({ value: "si" });
  await expect(resolveStaffLocale()).resolves.toBe("si");
  mockGet.mockReturnValue({ value: "en" });
  await expect(resolveStaffLocale()).resolves.toBe("en");
});

test("a missing cookie falls back to the staff default 'en' (not routing.defaultLocale 'si')", async () => {
  mockGet.mockReturnValue(undefined);
  await expect(resolveStaffLocale()).resolves.toBe("en");
});

test("an unrecognized cookie value falls back to 'en'", async () => {
  mockGet.mockReturnValue({ value: "xx" });
  await expect(resolveStaffLocale()).resolves.toBe("en");
});
