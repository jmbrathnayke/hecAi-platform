// Staff provisioning API client (FR-11) — the System Administrator's user management.
//
// Failures are a discriminated union rather than a thrown Error, matching lib/households.ts: the
// screen has to distinguish "you may not do this" from "the server has no service key configured"
// from "that address is already registered", and collapsing them into one "it failed" state leaves
// the real cause visible only in DevTools.
//
// The temporary password returned by create() is shown once and never stored. It is not written to
// localStorage, IndexedDB or a log — the administrator reads it off the screen and hands it over.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export type StaffRole = "officer" | "admin" | "ds_officer" | "system_admin";

export interface StaffScope {
  kind: "district" | "ds_division" | "assigned_divisions" | "none";
  value: string | string[] | null;
}

export interface StaffUser {
  id: string;
  email: string | null;
  role: StaffRole | null;
  scope: StaffScope;
  created_at: string | null;
  last_sign_in_at: string | null;
}

export interface CreateStaffInput {
  email: string;
  role: StaffRole;
  district_id?: string;
  ds_division?: string;
  assigned_divisions?: string[];
}

/** A DS division and the district it belongs to — the district disambiguates the several
 *  divisions that share a name with theirs. */
export interface DivisionRef {
  name: string;
  district: string;
}

export type ListResult =
  | { status: "ok"; users: StaffUser[]; districts: string[]; divisions: DivisionRef[] }
  | { status: "forbidden" }
  | { status: "unavailable" } // no service-role key configured on the server
  | { status: "error"; code: string };

export type MutateResult =
  | { status: "ok"; user: StaffUser; temporaryPassword?: string }
  | { status: "duplicate" }
  | { status: "invalid"; detail: string }
  | { status: "self" } // refused: would demote or delete the acting administrator
  | { status: "forbidden" }
  | { status: "unavailable" }
  | { status: "error"; code: string };

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getAccessToken();
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : null;
}

/** Map a non-ok response onto the union. Kept in one place so every call site agrees. */
function mapError(status: number, body: { error?: string; detail?: string }): MutateResult {
  if (status === 403) return { status: "forbidden" };
  if (status === 503) return { status: "unavailable" };
  if (status === 409 && body.error === "email_already_exists") return { status: "duplicate" };
  if (status === 409) return { status: "self" };
  if (status === 400) return { status: "invalid", detail: body.detail ?? body.error ?? "" };
  return { status: "error", code: body.error ?? String(status) };
}

export async function listStaff(): Promise<ListResult> {
  const headers = await authHeaders();
  if (!headers) return { status: "forbidden" };
  try {
    const res = await fetch(`${API_BASE}/api/v1/users`, { headers });
    if (res.status === 403) return { status: "forbidden" };
    if (res.status === 503) return { status: "unavailable" };
    if (!res.ok) return { status: "error", code: String(res.status) };
    const body = (await res.json()) as {
      users: StaffUser[];
      districts: string[];
      divisions: DivisionRef[];
    };
    return {
      status: "ok",
      users: body.users,
      districts: body.districts ?? [],
      divisions: body.divisions ?? [],
    };
  } catch {
    return { status: "error", code: "network" };
  }
}

export async function createStaff(input: CreateStaffInput): Promise<MutateResult> {
  const headers = await authHeaders();
  if (!headers) return { status: "forbidden" };
  try {
    const res = await fetch(`${API_BASE}/api/v1/users`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return mapError(res.status, body);
    return { status: "ok", user: body as StaffUser, temporaryPassword: body.temporary_password };
  } catch {
    return { status: "error", code: "network" };
  }
}

export async function updateStaff(
  id: string,
  input: Omit<CreateStaffInput, "email">,
): Promise<MutateResult> {
  const headers = await authHeaders();
  if (!headers) return { status: "forbidden" };
  try {
    const res = await fetch(`${API_BASE}/api/v1/users/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return mapError(res.status, body);
    return { status: "ok", user: body as StaffUser };
  } catch {
    return { status: "error", code: "network" };
  }
}

export async function deleteStaff(id: string): Promise<MutateResult> {
  const headers = await authHeaders();
  if (!headers) return { status: "forbidden" };
  try {
    const res = await fetch(`${API_BASE}/api/v1/users/${id}`, { method: "DELETE", headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return mapError(res.status, body);
    return { status: "ok", user: { id } as StaffUser };
  } catch {
    return { status: "error", code: "network" };
  }
}

/** Human-readable scope for a table cell. */
export function describeScope(scope: StaffScope): string {
  if (!scope || scope.kind === "none" || scope.value == null) return "—";
  return Array.isArray(scope.value) ? scope.value.join(", ") : scope.value;
}
