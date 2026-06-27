import { isValidNIC, isValidMobile } from "@/lib/validation";

describe("isValidNIC", () => {
  it("accepts legacy 9-digit + V/X", () => {
    expect(isValidNIC("123456789V")).toBe(true);
    expect(isValidNIC("123456789v")).toBe(true);
    expect(isValidNIC("123456789X")).toBe(true);
  });
  it("accepts new 12-digit NIC", () => {
    expect(isValidNIC("200012345678")).toBe(true);
  });
  it("trims surrounding whitespace", () => {
    expect(isValidNIC("  123456789V  ")).toBe(true);
  });
  it("rejects empty, short, or malformed values", () => {
    expect(isValidNIC("")).toBe(false);
    expect(isValidNIC("12345")).toBe(false);
    expect(isValidNIC("12345678V")).toBe(false); // 8 digits + V
    expect(isValidNIC("ABCDEFGHIV")).toBe(false);
    expect(isValidNIC("20001234567")).toBe(false); // 11 digits
  });
});

describe("isValidMobile", () => {
  it("accepts 10 digits starting with 07", () => {
    expect(isValidMobile("0712345678")).toBe(true);
    expect(isValidMobile("0779999999")).toBe(true);
  });
  it("rejects wrong prefix, wrong length, or non-digits", () => {
    expect(isValidMobile("")).toBe(false);
    expect(isValidMobile("0812345678")).toBe(false); // not 07
    expect(isValidMobile("071234567")).toBe(false); // 9 digits
    expect(isValidMobile("07123456789")).toBe(false); // 11 digits
    expect(isValidMobile("07ABCDEFGH")).toBe(false);
  });
});
