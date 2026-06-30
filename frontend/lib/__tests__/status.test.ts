import {
  isValidReference,
  statusKey,
  showApprovedAmount,
  UUID_V4_RE,
  HEC_RE,
} from "@/lib/status";

describe("reference validation", () => {
  it("accepts a canonical HEC id", () => {
    expect(isValidReference("HEC-2026-0001")).toBe(true);
    expect(HEC_RE.test("HEC-2026-12")).toBe(true);
  });

  it("accepts a v4 UUID", () => {
    expect(isValidReference("6529da13-aae0-4b42-9293-7b8df732cdcb")).toBe(true);
    expect(UUID_V4_RE.test("6529da13-aae0-4b42-9293-7b8df732cdcb")).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(isValidReference("  HEC-2026-0001  ")).toBe(true);
  });

  it("rejects garbage and non-v4 UUIDs", () => {
    expect(isValidReference("not-a-ref")).toBe(false);
    expect(isValidReference("")).toBe(false);
    // v1 UUID (version nibble 1) must be rejected by the strict v4 pattern
    expect(isValidReference("6529da13-aae0-1b42-9293-7b8df732cdcb")).toBe(false);
  });
});

describe("statusKey", () => {
  it("strips spaces for message keys", () => {
    expect(statusKey("Under Review")).toBe("UnderReview");
    expect(statusKey("Approved")).toBe("Approved");
  });
});

describe("showApprovedAmount", () => {
  it("only when status is Approved and an amount is present", () => {
    expect(showApprovedAmount({ status: "Approved", approved_amount: 5000 })).toBe(true);
    expect(showApprovedAmount({ status: "Approved" })).toBe(false);
    expect(showApprovedAmount({ status: "Submitted", approved_amount: 5000 })).toBe(false);
  });
});
