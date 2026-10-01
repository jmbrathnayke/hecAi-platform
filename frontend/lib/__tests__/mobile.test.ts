// normaliseMobile must agree with backend/app/api/v1/households.py `_clean_mobile`: the same inputs
// are listed in backend/tests/test_households.py, and both reduce them to "+94771234567".
import { formatMobile, normaliseMobile } from "@/lib/validation";

describe("normaliseMobile", () => {
  it.each([
    "0771234567",
    "077 123 4567",
    "077-123-4567",
    "771234567",
    "+94771234567",
    "+94 77 123 4567",
    "94771234567",
    "0094771234567",
    " (077) 123 4567 ",
  ])("reads %p as +94771234567", (typed) => {
    expect(normaliseMobile(typed)).toBe("+94771234567");
  });

  it("treats an empty field as 'no number', not as an error", () => {
    expect(normaliseMobile("")).toBe("");
    expect(normaliseMobile("   ")).toBe("");
  });

  it.each(["0112345678", "12345", "07712345678", "abc", "+44771234567"])(
    "refuses %p, which is not a Sri Lankan mobile",
    (typed) => {
      expect(normaliseMobile(typed)).toBeNull();
    },
  );
});

describe("formatMobile", () => {
  it("writes a stored number the local way", () => {
    expect(formatMobile("+94771234567")).toBe("077 123 4567");
  });
  it("leaves anything unexpected as it is", () => {
    expect(formatMobile("12345")).toBe("12345");
  });
});
