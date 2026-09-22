// Read-only view of a Supabase access token's payload, for CLIENT-SIDE ROUTING DECISIONS ONLY.
//
// Nothing here verifies a signature, and nothing decided from it grants access: every endpoint
// re-verifies the token and enforces the role from app_metadata server-side. It exists so the
// citizen app can avoid doing something pointless or confusing -- keying a local cache to the wrong
// account, or replaying a citizen's queued report under a staff session that happens to be signed
// in on the same browser.

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The JWT `sub`: an opaque account id. */
export function subjectFromToken(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === "string" && sub ? sub : null;
}

/** The staff role from app_metadata, or null for a citizen account (no role). */
export function staffRoleFromToken(token: string): string | null {
  const meta = decodeJwtPayload(token)?.app_metadata;
  const role = meta && typeof meta === "object" ? (meta as { role?: unknown }).role : undefined;
  return typeof role === "string" && role ? role : null;
}
