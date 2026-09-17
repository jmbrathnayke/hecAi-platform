import { isSafeRelativePath, notificationTarget } from "@/lib/notificationTarget";

describe("notificationTarget", () => {
  it("opens the protected officer case page named by the payload", () => {
    expect(notificationTarget({ ref: "HEC-2026-0001", url: "/officer/cases/HEC-2026-0001" })).toBe(
      "/officer/cases/HEC-2026-0001",
    );
  });

  it("opens the admin and DS case surfaces with their query string", () => {
    expect(notificationTarget({ url: "/admin/cases?ref=HEC-2026-0001" })).toBe(
      "/admin/cases?ref=HEC-2026-0001",
    );
    expect(notificationTarget({ url: "/ds/dashboard?ref=HEC-2026-0001" })).toBe(
      "/ds/dashboard?ref=HEC-2026-0001",
    );
  });

  it("falls back to the public status page when no url is given (older payloads)", () => {
    expect(notificationTarget({ ref: "HEC-2026-0001" })).toBe("/status?ref=HEC-2026-0001");
  });

  it("falls back to home with neither a url nor a reference", () => {
    expect(notificationTarget({})).toBe("/");
    expect(notificationTarget(undefined)).toBe("/");
  });

  it.each([
    "https://evil.example/officer/cases/HEC-2026-0001",
    "//evil.example/path",
    "/\\evil.example",
    "javascript:alert(1)",
    "officer/cases/HEC-2026-0001",
    "/officer\n/cases",
    "",
  ])("never follows an unsafe url: %p", (url) => {
    expect(isSafeRelativePath(url)).toBe(false);
    expect(notificationTarget({ ref: "HEC-2026-0001", url })).toBe("/status?ref=HEC-2026-0001");
  });

  it("encodes the reference in the fallback", () => {
    expect(notificationTarget({ ref: "a b&c" })).toBe("/status?ref=a%20b%26c");
  });
});
