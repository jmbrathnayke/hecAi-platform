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
