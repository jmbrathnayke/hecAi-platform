// Web Push subscription client.
//
// ONE OF TWO NOTIFICATION CHANNELS. Citizens are notified by Web Push, then email; staff by Web
// Push. Push needs no vendor account, and it carries no personal data: the subscription is an
// opaque endpoint URL the browser mints, not a phone number or an address, so nothing here needs
// the protection the NIC and bank fields need in lib/households.ts.
//
// EVERY FUNCTION RESOLVES, NONE THROW. Notifications are an enhancement layered on top of a system
// that already works without them (the public status page needs no login, no permission and no
// subscription). A browser that denies permission, blocks the push service, or runs without a
// service worker must degrade quietly — never surface an error the citizen cannot act on.
import { getAccessToken } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export type PushState =
  | "unsupported" // no service worker or no Push API (older browsers, iOS Safari not installed)
  | "unavailable" // supported here, but the server has no VAPID keypair provisioned
  | "denied" // the citizen refused, or the browser refuses on their behalf
  | "subscribed"
  | "unsubscribed";

/**
 * Whether this browser can subscribe at all.
 *
 * Deliberately does not check Notification.permission: a "default" permission is not a failure,
 * it is the state before the citizen has been asked.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Convert a base64url VAPID key to the Uint8Array the Push API requires.
 *
 * applicationServerKey rejects a string, and the key is transported base64url (no padding, - and _
 * for + and /), so both the alphabet and the padding have to be restored before decoding.
 */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * The server's VAPID public key, or null when push is not provisioned.
 *
 * Read from the API rather than NEXT_PUBLIC_VAPID_PUBLIC_KEY so the key has one source of truth:
 * a build-time env var would let the frontend and backend drift apart after a rotation, and every
 * existing subscription would then fail to decrypt with no visible cause.
 */
export async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/notifications/push/key`);
    if (!res.ok) return null;
    const data = (await res.json()) as { public_key?: string; available?: boolean };
    return data.available && data.public_key ? data.public_key : null;
  } catch {
    return null;
  }
}

/** The current subscription for this browser, or null. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Ask permission, subscribe, and register the subscription with the backend.
 *
 * Must be called from a user gesture. Browsers increasingly refuse (or permanently block) a
 * permission prompt that appears unprompted on page load, and a blocked prompt cannot be re-asked
 * — so the caller is responsible for putting this behind an explicit control.
 */
export async function subscribeToPush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const vapidKey = await getVapidKey();
  if (!vapidKey) return "unavailable";

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";

    const registration = await navigator.serviceWorker.ready;

    // Reuse an existing subscription rather than creating a second one for the same browser.
    // subscribe() would return the existing one anyway, but only when applicationServerKey
    // matches — after a key rotation it throws instead, so the old one is cleared first.
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const current = subscription.options?.applicationServerKey;
      const matches =
        current instanceof ArrayBuffer &&
        new Uint8Array(current).toString() === urlBase64ToUint8Array(vapidKey).toString();
      if (!matches) {
        await subscription.unsubscribe().catch(() => undefined);
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        // Required by Chrome: it refuses subscriptions whose payloads the site cannot read.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }

    const token = await getAccessToken();
    if (!token) return "unsubscribed"; // signed out mid-flow; the browser subscription is harmless

    const payload = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    const res = await fetch(`${API_BASE}/api/v1/notifications/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        endpoint: payload.endpoint,
        keys: payload.keys,
        locale: document.documentElement.lang || undefined,
      }),
    });

    return res.ok ? "subscribed" : "unsubscribed";
  } catch {
    // A denied permission surfaces as a rejection in some browsers rather than a "denied" result.
    return "denied";
  }
}

/** Unsubscribe this browser, both locally and on the server. */
export async function unsubscribeFromPush(): Promise<PushState> {
  const subscription = await getExistingSubscription();
  if (!subscription) return "unsubscribed";

  const endpoint = subscription.endpoint;

  // Drop the local subscription first: if the network call fails afterwards the citizen still
  // stops receiving notifications, which is what they asked for. The reverse order could leave
  // them subscribed after being told they were not.
  await subscription.unsubscribe().catch(() => undefined);

  try {
    const token = await getAccessToken();
    if (token) {
      await fetch(`${API_BASE}/api/v1/notifications/push/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint }),
      });
    }
  } catch {
    // The server row is now orphaned. Harmless: the push service returns 410 Gone on the next
    // send and push_service.py deletes it.
  }

  return "unsubscribed";
}
