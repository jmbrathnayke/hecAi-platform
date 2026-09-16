import en from "@/messages/en.json";
import si from "@/messages/si.json";
import ta from "@/messages/ta.json";

/** The three shipped catalogues, so a missing string fails here rather than on a reader’s screen. */
const CATALOGUES = { en: en.status, si: si.status, ta: ta.status };

import {
  CLAIM_JOURNEY,
  HEC_RE,
  KNOWN_STATUSES,
  TRANSLATED_STATUSES,
  UUID_V4_RE,
  isTranslatedStatus,
  isValidReference,
  journeyIndex,
  showApprovedAmount,
  statusKey,
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

describe("the claim journey (FR-6.1)", () => {
  // The defect these guard against: StatusCard decided whether a status could be translated by
  // testing membership of KNOWN_STATUSES — the officer dashboard's FILTER list, which stops at
  // "Rejected". A claim that had been PAID fell through to the raw English string and a neutral
  // grey chip, in Sinhala and Tamil too, for the one outcome the workflow exists to reach.
  it("treats a paid claim as translatable, not just the four filterable ones", () => {
    expect(isTranslatedStatus("Payment Processed")).toBe(true);
    for (const s of KNOWN_STATUSES) expect(isTranslatedStatus(s)).toBe(true);
    expect(isTranslatedStatus("Something Else")).toBe(false);
  });

  it("every translatable status has a label and a next-step sentence in all three languages", () => {
    // Catches the other half of the same bug: a status the card is willing to translate but for
    // which some language has no string, which renders as a raw message key to that reader.
    const missing: string[] = [];
    for (const [lang, messages] of Object.entries(CATALOGUES)) {
      for (const status of TRANSLATED_STATUSES) {
        const key = statusKey(status);
        const labels = messages.statusLabels as Record<string, string>;
        const next = messages.nextStep as Record<string, string>;
        if (!labels[key]) missing.push(`${lang}.statusLabels.${key}`);
        if (!next[key]) missing.push(`${lang}.nextStep.${key}`);
      }
    }
    // Named rather than counted: the failure output should say which string is absent in which
    // language, not merely that one is.
    expect(missing).toEqual([]);
  });

  it("orders the journey and keeps rejection off it", () => {
    expect(journeyIndex("Submitted")).toBe(0);
    expect(journeyIndex("Payment Processed")).toBe(CLAIM_JOURNEY.length - 1);
    expect(journeyIndex("Under Review")).toBeLessThan(journeyIndex("Approved"));
    // A rejected claim did not travel further than a pending one; placing it on the track would
    // render it as a completed journey.
    expect(journeyIndex("Rejected")).toBe(-1);
  });
});
