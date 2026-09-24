// Setting one's own password — the same operation for a citizen and for staff.
//
// WHY A PASSWORD EXISTS AT ALL. Accounts are created by a one-time email link, which is what
// verifies the address; the password is for signing in afterwards. The link therefore stays as the
// recovery path, so forgetting a password never locks a family out of their claim.
import { createClient } from "@/lib/supabase";

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Set a new password for the signed-in account. Nothing else is touched: a role and its area live
 * in app_metadata, writable only with the service-role key (see middleware/auth.py).
 */
export async function changeOwnPassword(password: string): Promise<"ok" | "error"> {
  try {
    const { error } = await createClient().auth.updateUser({ password });
    return error ? "error" : "ok";
  } catch {
    return "error";
  }
}
