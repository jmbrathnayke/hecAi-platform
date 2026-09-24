// In-app notification feed (the bell).
//
// WHAT THIS IS READING. The server derives the feed from audit_log rather than from a notifications
// table, because the audience of every alert is already recorded there: notify_staff_push() writes
// one row per alert carrying {alert, role, scope}, and it writes it whether or not anyone was
// subscribed to push. So the bell shows what this account was notified about even on a deployment
// where nobody ever granted the browser permission prompt — which is the normal state, and the
// reason the bell exists at all.
//
// Scoping is entirely the server's, from the verified JWT: an officer's divisions, an
// administrator's district, a citizen's own household. This module never sends a scope.
//
// Failures are a discriminated union, the same discipline as lib/dsCases.ts: "you are signed out"
// and "the server is down" need different screens, and collapsing them loses the difference.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

/** Where the client remembers how far it has read. Per browser, never sent anywhere. */
const LAST_SEEN_KEY = "hec-notifications-last-seen";

export interface NotificationItem {
  /** The audit_log row id. Monotonic, which is what makes "unread" a simple comparison. */
  id: number;
  event: string;
  /** The staff alert key, or the citizen-facing status. Null when the row carried neither. */
  subject: string | null;
  canonical_id: string | null;
  scope: string | null;
  created_at: string | null;
}

export type FeedFailure =
  | { reason: "no-session" }
  | { reason: "signed-out"; status: number }
  | { reason: "server"; status: number }
  | { reason: "network" };

export type FeedResult =
  | { ok: true; notifications: NotificationItem[]; count: number; reason?: string }
  | { ok: false; failure: FeedFailure };

export async function fetchNotifications(): Promise<FeedResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/notifications/feed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  if (res.status === 401) return { ok: false, failure: { reason: "signed-out", status: 401 } };
  if (!res.ok) return { ok: false, failure: { reason: "server", status: res.status } };

  try {
    const body = (await res.json()) as {
      notifications?: unknown;
      count?: unknown;
      reason?: unknown;
    };
    // A 200 with the wrong shape is a server failure, not an empty feed — an empty bell and a
    // broken endpoint must not look the same to whoever is waiting to be told something.
    if (!Array.isArray(body.notifications)) {
      return { ok: false, failure: { reason: "server", status: res.status } };
    }
    return {
      ok: true,
      notifications: body.notifications as NotificationItem[],
      count: typeof body.count === "number" ? body.count : body.notifications.length,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    };
  } catch {
    return { ok: false, failure: { reason: "server", status: res.status } };
  }
}

/** The highest id this browser has seen, or 0. Never throws: storage can be unavailable in a
 *  private window or with site data blocked, and the bell must still render. */
export function readLastSeenId(): number {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Remember how far the viewer has read. Only ever moves forward, so opening an older tab cannot
 *  resurrect notifications the viewer has already dealt with. */
export function writeLastSeenId(id: number): void {
  try {
    if (id > readLastSeenId()) window.localStorage.setItem(LAST_SEEN_KEY, String(id));
  } catch {
    // No storage: every visit shows the full list as unread. The right way round for a
    // convenience — it over-informs rather than silently hiding something.
  }
}

export function unreadCount(items: NotificationItem[], lastSeenId: number): number {
  return items.filter((n) => n.id > lastSeenId).length;
}

/** The staff alert keys and citizen statuses that have translated labels. Anything outside this
 *  list falls back to the raw subject, so a new server-side alert appears in the bell as soon as it
 *  is emitted rather than vanishing until the frontend catches up. */
export const KNOWN_SUBJECTS = [
  "case_submitted",
  "assessment_complete",
  "payment_pending",
  "final_decision_recorded",
  "payment_processed",
  "Submitted",
  "Under Review",
  "Assessment Complete",
  "Approved",
  "Rejected",
  "Final Decision",
  "Payment Processed",
] as const;

export function isKnownSubject(subject: string | null): boolean {
  return subject !== null && (KNOWN_SUBJECTS as readonly string[]).includes(subject);
}
