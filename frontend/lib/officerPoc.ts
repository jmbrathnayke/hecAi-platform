// Shared sessionStorage key for carrying the CITIZEN NIC's last-4 mask from the officer submit
// flow to the officer PoC receipt (Story 3.5, AC6). Only the already-masked last 4 characters
// are stored — never the full plaintext NIC — and only in sessionStorage (in-session, cleared
// when the tab closes), never in IndexedDB and never sent to the server (NFR-3.1).
export const OFFICER_POC_NIC_KEY = "hec-officer-poc-nic-last4";

/**
 * Clears the carried NIC-mask entry. Called whenever a case boundary is crossed (a stale
 * completed draft is discarded, or the officer starts a new submission) so a previous
 * citizen's masked NIC can never linger into the next case's PoC render.
 */
export function clearOfficerPocMask(): void {
  try {
    sessionStorage.removeItem(OFFICER_POC_NIC_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}
