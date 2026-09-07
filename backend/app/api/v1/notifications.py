"""Web Push subscription API.

    GET  /api/v1/notifications/push/key          the VAPID public key       (no auth)
    POST /api/v1/notifications/push/subscribe    register this browser      (citizen JWT)
    POST /api/v1/notifications/push/unsubscribe  drop this browser          (citizen JWT)

WHY THIS STORES NO PERSONAL DATA. A push subscription is an opaque endpoint URL minted by the
browser's own push service, plus the public half of a keypair used to encrypt payloads to that one
browser install. It names nobody, reaches nobody by any other route, and dies when the user clears
site data. So unlike the SMS path (which needs a plaintext mobile) and the email path (a plaintext
address), this channel carries no citizen PII and needs no amendment to NFR-3.1.

THE KEY ENDPOINT IS DELIBERATELY UNAUTHENTICATED. A VAPID public key is public by construction --
it is handed to every browser that subscribes and travels in the clear to the push service. Gating
it would protect nothing and would stop the subscribe prompt working before sign-in completes.
The PRIVATE key never leaves the server and is never returned by any endpoint.

ROUTING. Subscriptions hang off the household, matching households.contact_email, because a case
resolves to a household (migration 025) and a household resolves to every device its members have
subscribed on. A citizen with no registered household can still subscribe: household_id stays NULL
and the row starts routing as soon as they register, rather than the prompt failing confusingly.
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_citizen
from app.infrastructure import registry

notifications_bp = Blueprint("notifications", __name__)

SUPPORTED_LOCALES = ("si", "ta", "en")
DEFAULT_LOCALE = "si"

# A push endpoint is a URL; browsers issue them well under this. The cap exists so a malformed or
# hostile body cannot push an unbounded string into the table, not as a protocol statement.
MAX_ENDPOINT_LEN = 2000
MAX_KEY_LEN = 500


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _clean(value, limit):
    """-> a trimmed string within `limit`, or None. Never raises on odd input."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed or len(trimmed) > limit:
        return None
    return trimmed


@notifications_bp.route("/notifications/push/key", methods=["GET"])
def push_key():
    """The applicationServerKey the browser needs, and whether push is provisioned at all.

    `available` lets the UI hide the prompt entirely on a deployment with no keypair, rather than
    offering a subscription that could never be delivered to.
    """
    public_key = current_app.config.get("VAPID_PUBLIC_KEY")
    return jsonify({"public_key": public_key, "available": bool(public_key)}), 200


@notifications_bp.route("/notifications/push/subscribe", methods=["POST"])
@require_citizen()
def subscribe():
    citizen_id = g.citizen_id  # verified JWT sub — never from the request body
    body = request.get_json(silent=True) or {}

    endpoint = _clean(body.get("endpoint"), MAX_ENDPOINT_LEN)
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    p256dh = _clean(keys.get("p256dh"), MAX_KEY_LEN)
    auth = _clean(keys.get("auth"), MAX_KEY_LEN)

    if not endpoint or not p256dh or not auth:
        return jsonify({"error": "invalid_subscription"}), 400
    if not endpoint.startswith("https://"):
        # Push services are HTTPS without exception; anything else is a malformed or forged body.
        return jsonify({"error": "invalid_subscription"}), 400

    locale = body.get("locale")
    locale = locale if locale in SUPPORTED_LOCALES else DEFAULT_LOCALE

    conn = None
    try:
        conn = _get_connection()
        with conn:
            with conn.cursor() as cur:
                household = registry.resolve_by_registrant(cur, citizen_id)
                household_id = household["id"] if household else None

                # Re-subscribing from the same browser must update, not 409: a browser may rotate
                # its keys for an unchanged endpoint, and a citizen may register a household after
                # first granting permission, which is exactly when household_id needs filling in.
                cur.execute(
                    """INSERT INTO push_subscriptions
                         (household_id, citizen_uid, endpoint, p256dh, auth, locale, last_used_at)
                       VALUES (%s, %s, %s, %s, %s, %s, now())
                       ON CONFLICT (endpoint) DO UPDATE
                         SET household_id = EXCLUDED.household_id,
                             citizen_uid  = EXCLUDED.citizen_uid,
                             p256dh       = EXCLUDED.p256dh,
                             auth         = EXCLUDED.auth,
                             locale       = EXCLUDED.locale,
                             last_used_at = now()""",
                    (household_id, citizen_id, endpoint, p256dh, auth, locale),
                )
        # No audit_log row: this is a device preference, not an action on a case, and audit_log is
        # keyed by case_id. Writing one would attach an unrelated event to some arbitrary case.
        return jsonify({"subscribed": True, "routed": household_id is not None}), 201
    except psycopg2.Error:
        current_app.logger.exception("failed to store push subscription")
        return jsonify({"error": "subscription_failed"}), 500
    finally:
        if conn is not None:
            conn.close()


@notifications_bp.route("/notifications/push/unsubscribe", methods=["POST"])
@require_citizen()
def unsubscribe():
    """Drop one browser's subscription.

    Scoped to the caller's own citizen_uid as well as the endpoint: without that, knowing any
    endpoint string would let one account silence another family's notifications.
    """
    citizen_id = g.citizen_id
    body = request.get_json(silent=True) or {}
    endpoint = _clean(body.get("endpoint"), MAX_ENDPOINT_LEN)
    if not endpoint:
        return jsonify({"error": "invalid_subscription"}), 400

    conn = None
    try:
        conn = _get_connection()
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = %s AND citizen_uid = %s",
                    (endpoint, citizen_id),
                )
                removed = cur.rowcount
        # 200 whether or not a row matched: an unsubscribe that finds nothing has still achieved
        # what the caller asked for, and a 404 would confirm whether an endpoint exists.
        return jsonify({"unsubscribed": True, "removed": removed}), 200
    except psycopg2.Error:
        current_app.logger.exception("failed to remove push subscription")
        return jsonify({"error": "unsubscribe_failed"}), 500
    finally:
        if conn is not None:
            conn.close()
