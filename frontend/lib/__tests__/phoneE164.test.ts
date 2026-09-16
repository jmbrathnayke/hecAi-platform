import { toE164SriLanka } from "@/lib/validation";

/**
 * Supabase phone auth requires E.164. The login form asks for the number the way it is written in
 * Sri Lanka (07X XXX XXXX), so the conversion has to happen before the send — otherwise every
 * attempt fails with a provider error that reads as "check the number" when the number is fine.
 */
describe("the four ways a Sri Lankan mobile gets typed", () => {
  it.each([
    ["0714790447", "+94714790447", "local, as written on paper"],
    ["714790447", "+94714790447", "local without the trunk 0"],
    ["94714790447", "+94714790447", "country code, no plus"],
    ["+94714790447", "+94714790447", "already E.164"],
  ])("%s -> %s (%s)", (input, expected) => {
    expect(toE164SriLanka(input)).toBe(expected);
  });

  it("drops the trunk 0 rather than keeping it", () => {
    // +940714790447 is not a valid number — this is the specific mistake that makes the send fail.
    expect(toE164SriLanka("0714790447")).not.toContain("+940");
  });
});

describe("tolerates how people actually type", () => {
  it.each([
    "071 479 0447",
    "071-479-0447",
    "  0714790447  ",
    "(071) 4790447",
    "+94 71 479 0447",
  ])("%s", (input) => {
    expect(toE164SriLanka(input)).toBe("+94714790447");
  });
});

describe("rejects what is not a Sri Lankan mobile", () => {
  it.each([
    ["", "empty"],
    ["071479044", "one digit short"],
    ["07147904477", "one digit too many"],
    ["abcdefghij", "letters"],
    ["+441234567890", "another country"],
    ["0000", "far too short"],
  ])("%s (%s)", (input) => {
    expect(toE164SriLanka(input)).toBeNull();
  });

  it.each([null, undefined, 714790447, {}])("rejects non-strings: %p", (input) => {
    expect(toE164SriLanka(input as unknown as string)).toBeNull();
  });
});

describe("round-trip stability", () => {
  it("converting an already-converted number changes nothing", () => {
    const once = toE164SriLanka("0714790447")!;
    expect(toE164SriLanka(once)).toBe(once);
  });

  it("every accepted form produces the identical string", () => {
    const forms = ["0714790447", "714790447", "94714790447", "+94714790447", "071 479 0447"];
    const results = new Set(forms.map((f) => toE164SriLanka(f)));
    // One person, one number — verifyOtp must receive exactly what signInWithOtp received.
    expect(results.size).toBe(1);
  });
});
