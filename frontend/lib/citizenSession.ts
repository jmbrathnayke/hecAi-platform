// Citizen sign-out, shared by the Profile page and My Claims so both end a session the same way.
import { createClient } from "@/lib/supabase";
import { clearDraftId } from "@/lib/draft";
import { forgetRegistration } from "@/lib/registrationState";

export async function signOutCitizen(): Promise<void> {
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
