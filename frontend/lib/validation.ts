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

// Sri Lanka mobile -> E.164, for Supabase phone auth.
//
// Supabase's signInWithOtp({ phone }) requires E.164 (+94XXXXXXXXX). The login form asks for a
// number the way a Sri Lankan writes it — 07X XXX XXXX — so without this conversion every send
// fails with a provider error that reads, unhelpfully, as "check the number": the number IS
// correct, the format is not.
export const SRI_LANKA_DIALLING_CODE = "+94";

/**
 * -> the number in E.164, or null if it is not a recognisable Sri Lankan mobile.
 *
 * Accepts the four ways people actually type it, and tolerates spaces, dashes and brackets:
 *   0714790447      local, how it is written on paper
 *   714790447       local without the trunk 0
 *   94714790447     country code, no plus
 *   +94714790447    already E.164
 */
export function toE164SriLanka(input: string): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[\s\-()]/g, "");
  // Every branch requires the leading 7: Sri Lankan mobiles are 07X XXX XXXX. Without it, a
  // nine-digit typo like "071479044" (one digit short) matched the no-trunk-zero rule and became
  // "+94071479044" — a plausible-looking, undeliverable number that would fail at the provider
  // rather than in the form, where the user could still fix it.
  if (/^\+947[0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^947[0-9]{8}$/.test(cleaned)) return `+${cleaned}`;
  // The trunk prefix 0 is dropped in E.164, not kept: +940714790447 is not a valid number.
  if (/^07[0-9]{8}$/.test(cleaned)) return `${SRI_LANKA_DIALLING_CODE}${cleaned.slice(1)}`;
  if (/^7[0-9]{8}$/.test(cleaned)) return `${SRI_LANKA_DIALLING_CODE}${cleaned}`;
  return null;
}
