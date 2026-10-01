// Pure validators for the incident form. Kept framework-free so they are easily unit-tested.

// Sri Lanka NIC: legacy 9 digits + V/X, or new 12 digits.
export const NIC_REGEX = /^([0-9]{9}[vVxX]|[0-9]{12})$/;
// Sri Lanka mobile: 10 digits starting with 07.
export const MOBILE_REGEX = /^07[0-9]{8}$/;

export function isValidNIC(nic: string): boolean {
  return NIC_REGEX.test(nic.trim());
}

export function isValidMobile(mobile: string): boolean {
  return MOBILE_REGEX.test(mobile.trim());
}

/**
 * A Sri Lankan mobile number in its one stored spelling, "+947XXXXXXXX" (migration 039).
 * Accepts the ways people type it: "077 123 4567", "0771234567", "771234567", "+94 77 123 4567",
 * "0094771234567". Returns "" for an empty field and null for anything that is not a mobile.
 * Mirrors backend/app/api/v1/households.py `_clean_mobile`; the two must agree.
 */
export function normaliseMobile(value: string): string | null {
  let digits = value.replace(/[\s\-().]/g, "");
  if (digits === "") return "";
  if (digits.startsWith("+94")) digits = digits.slice(3);
  else if (digits.startsWith("0094")) digits = digits.slice(4);
  else if (digits.startsWith("94") && digits.length === 11) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return /^7[0-9]{8}$/.test(digits) ? `+94${digits}` : null;
}

/** "+94771234567" -> "077 123 4567", the way the number is written locally. */
export function formatMobile(stored: string): string {
  const m = /^\+94(7[0-9])([0-9]{3})([0-9]{4})$/.exec(stored);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : stored;
}
