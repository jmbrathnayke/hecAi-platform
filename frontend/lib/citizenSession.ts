// Citizen sign-out, shared by the Profile page and My Claims so both end a session the same way.
import { createClient } from "@/lib/supabase";
import { clearDraftId } from "@/lib/draft";
import { forgetRegistration } from "@/lib/registrationState";
import { flushCitizenOutbox } from "@/lib/citizenOutbox";
import { flushCitizenPhotos } from "@/lib/citizenPhotoOutbox";

// Longest sign-out waits for reports and photographs still on the phone. Long enough for a couple
// of photographs on a rural connection, short enough that pressing "Sign out" never feels stuck.
export const FINAL_FLUSH_MS = 10_000;

/**
 * Send whatever is still waiting while this family's session still exists. After sign-out the
 * outboxes cannot run (they need a citizen token), and an officer signing in on the same phone
 * must not, by design, upload a family's photographs under the officer's own identity. That pair
 * is how photographs used to be left behind: report, sign out, officer signs in -- and the case
 * the officer opened had no photographs. Best-effort and time-boxed; nothing is lost if it fails,
 * because the outboxes keep the work for the next time this family signs in here.
 */
async function sendWhatIsWaiting(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const work = flushCitizenOutbox()
    .then(() => flushCitizenPhotos(Date.now(), { force: true }))
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FINAL_FLUSH_MS);
  });
  try {
    await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}

export async function signOutCitizen(): Promise<void> {
  await sendWhatIsWaiting();
  try {
    await createClient().auth.signOut();
  } catch {
    // Best-effort: the local cleanup below still runs, and the caller navigates away regardless.
  }
  // On a shared phone the next person must not inherit this family's confirmed registration or a
  // half-filled report.
  forgetRegistration();
  clearDraftId();
}
