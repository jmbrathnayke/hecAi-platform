// The signed-in staff member's account, for the navbar account menu and the officer profile.
// DISPLAY ONLY: read from the local session, so it is never an authorization decision — every
// staff API re-verifies the JWT and its app_metadata claims server-side (CRITICAL #2).
import { createClient } from "@/lib/supabase";
import { deleteSessionValue } from "@/lib/indexeddb";

export type StaffRole = "officer" | "admin" | "ds_officer" | "system_admin";

export interface StaffAccount {
  email: string | null;
  role: StaffRole | null;
  /** The area the role is scoped to: assigned divisions, a district, or a DS division. */
  scope: string[];
  /** Signs in with a password (not only Google), so has a password to change. */
  canChangePassword: boolean;
}

export const MIN_PASSWORD_LENGTH = 8;

const ROLES: readonly StaffRole[] = ["officer", "admin", "ds_officer", "system_admin"];

export function accountFromMetadata(email: string | null, metadata: Record<string, unknown>): StaffAccount {
  const role = ROLES.includes(metadata.role as StaffRole) ? (metadata.role as StaffRole) : null;
  let scope: string[] = [];
  if (role === "officer" && Array.isArray(metadata.assigned_divisions)) {
    scope = metadata.assigned_divisions.filter((d): d is string => typeof d === "string");
  } else if (role === "admin" && typeof metadata.district_id === "string") {
    scope = [metadata.district_id];
  } else if (role === "ds_officer" && typeof metadata.ds_division === "string") {
    scope = [metadata.ds_division];
  }
  const canChangePassword = Array.isArray(metadata.providers) && metadata.providers.includes("email");
  return { email, role, scope, canChangePassword };
}

/**
 * Set a new password for the signed-in account. Role and area are deliberately not changeable here:
 * they live in app_metadata, which only the service-role key can write (see middleware/auth.py).
 */
export async function changeStaffPassword(password: string): Promise<"ok" | "error"> {
  try {
    const { error } = await createClient().auth.updateUser({ password });
    return error ? "error" : "ok";
  } catch {
    return "error";
  }
}

export async function readStaffAccount(): Promise<StaffAccount | null> {
  try {
    const { data } = await createClient().auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    return accountFromMetadata(user.email ?? null, (user.app_metadata ?? {}) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function signOutStaff(): Promise<void> {
  try {
    await createClient().auth.signOut();
  } catch {
    // Best-effort: the caller navigates to the login page regardless.
  }
  // The officer and admin hooks cache the last session for offline display; on a shared device
  // the next person must not see this account's name and area.
  await Promise.all(["officer", "admin"].map((key) => deleteSessionValue(key).catch(() => {})));
}
