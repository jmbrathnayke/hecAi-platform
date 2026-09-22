"""Web Push subscription API.

    GET  /api/v1/notifications/push/key          the VAPID public key       (no auth)
    POST /api/v1/notifications/push/subscribe    register this browser      (citizen JWT)
    POST /api/v1/notifications/push/unsubscribe  drop this browser          (citizen JWT)

WHY THIS STORES NO PERSONAL DATA. A push subscription is an opaque endpoint URL minted by the
browser's own push service, plus the public half of a keypair used to encrypt payloads to that one
browser install. It names nobody, reaches nobody by any other route, and dies when the user clears
site data. So unlike the email path (a plaintext address), this channel carries no citizen PII
and needs no amendment to NFR-3.1.

THE KEY ENDPOINT IS DELIBERATELY UNAUTHENTICATED. A VAPID public key is public by construction --
it is handed to every browser that subscribes and travels in the clear to the push service. Gating
it would protect nothing and would stop the subscribe prompt working before sign-in completes.
The PRIVATE key never leaves the server and is never returned by any endpoint.

ROUTING, CITIZEN. Subscriptions hang off the household, matching households.contact_email, because
a case resolves to a household (migration 025) and a household resolves to every device its members
have subscribed on. A citizen with no registered household can still subscribe: household_id stays
NULL and the row starts routing as soon as they register, rather than the prompt failing
confusingly.

ROUTING, STAFF (migration 032). A staff subscription routes by role and administrative scope
instead -- "every DS officer covering this division", "every field officer assigned to it". The
scope is taken from the SIGNATURE-VERIFIED JWT, never from the request body: a browser that could
name its own scope could subscribe itself to a district it has no authority over and read case
references it may not see.

WHY THIS ENDPOINT NO LONGER USES require_citizen(). That guard rejects every staff role by design
-- it exists to stop a staff `sub` being written into citizen-owned rows -- so while it was in
place no officer, administrator or DS officer could subscribe at all, which is exactly why
staff-directed alerting did not exist. The guard is replaced by an explicit branch on the verified
role: a citizen takes the household path unchanged, a staff member takes the scope path. Nothing
reads the role from anywhere but the token.
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import (
    authenticated_claims,
    authz_metadata,
    authz_role,
)
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


# The roles that route by administrative scope rather than by household. `system_admin` is included
# so the toggle on their dashboard works, but they hold no district or division claim, so their
# scope is empty and `= ANY(staff_scope)` never matches -- they receive no case-level alert. That
# falls out of the data rather than needing a special case, which is why it is left implicit.
STAFF_ROLES = ("officer", "admin", "ds_officer", "system_admin")


def _staff_scope(role, meta):
    """-> the administrative areas this staff account covers, as a list.

    Normalises three differently-shaped claims into one array so every routing query can be the
    same shape (see migration 032). Returns [] rather than None for an account with no scope: an
    empty array matches nothing, which is the correct fail-closed behaviour for a routing key.
    """
    if role == "admin":
        value = meta.get("district_id")
        return [value] if isinstance(value, str) and value.strip() else []
    if role == "ds_officer":
        value = meta.get("ds_division")
        return [value] if isinstance(value, str) and value.strip() else []
    if role == "officer":
        value = meta.get("assigned_divisions")
        if not isinstance(value, list):
            return []
        return [v for v in value if isinstance(v, str) and v.strip()]
    return []


def _subscription_body(body):
    """-> (endpoint, p256dh, auth, locale) or (None, ...) if the payload is not a subscription."""
    endpoint = _clean(body.get("endpoint"), MAX_ENDPOINT_LEN)
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    p256dh = _clean(keys.get("p256dh"), MAX_KEY_LEN)
    auth = _clean(keys.get("auth"), MAX_KEY_LEN)
    locale = body.get("locale")
    locale = locale if locale in SUPPORTED_LOCALES else DEFAULT_LOCALE
    if not endpoint or not p256dh or not auth or not endpoint.startswith("https://"):
        # Push services are HTTPS without exception; anything else is malformed or forged.
        return None, None, None, locale
    return endpoint, p256dh, auth, locale


@notifications_bp.route("/notifications/push/key", methods=["GET"])
def push_key():
    """The applicationServerKey the browser needs, and whether push is provisioned at all.

    `available` lets the UI hide the prompt entirely on a deployment with no keypair, rather than
    offering a subscription that could never be delivered to.
    """
    public_key = current_app.config.get("VAPID_PUBLIC_KEY")
    return jsonify({"public_key": public_key, "available": bool(public_key)}), 200


@notifications_bp.route("/notifications/push/subscribe", methods=["POST"])
def subscribe():
    claims, error = authenticated_claims()
    if error:
        return error
    account_id = claims.get("sub")
    if not account_id:
        return jsonify({"error": "invalid_token"}), 401

    role = authz_role(claims)
    body = request.get_json(silent=True) or {}
    endpoint, p256dh, auth, locale = _subscription_body(body)
    if not endpoint:
        return jsonify({"error": "invalid_subscription"}), 400

    conn = None
    try:
        conn = _get_connection()
        with conn:
            with conn.cursor() as cur:
                if role in STAFF_ROLES:
                    scope = _staff_scope(role, authz_metadata(claims))
                    # Re-subscribing overwrites the scope, which is what makes a re-assignment take
                    # effect: an officer moved to another division re-subscribes on next sign-in and
                    # stops receiving the old division's alerts.
                    cur.execute(
                        """INSERT INTO push_subscriptions
                             (staff_uid, staff_role, staff_scope,
                              endpoint, p256dh, auth, locale, last_used_at)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                           ON CONFLICT (endpoint) DO UPDATE
                             SET staff_uid    = EXCLUDED.staff_uid,
                                 staff_role   = EXCLUDED.staff_role,
                                 staff_scope  = EXCLUDED.staff_scope,
                                 household_id = NULL,
                                 citizen_uid  = NULL,
                                 p256dh       = EXCLUDED.p256dh,
                                 auth         = EXCLUDED.auth,
                                 locale       = EXCLUDED.locale,
                                 last_used_at = now()""",
                        (account_id, role, scope, endpoint, p256dh, auth, locale),
                    )
                    # `routed` reports whether this row can actually receive anything, so the UI can
                    # say "on, but nothing is scoped to you" instead of claiming success.
                    return jsonify({"subscribed": True, "routed": bool(scope),
                                    "role": role}), 201

                household = registry.resolve_by_registrant(cur, account_id)
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
                             staff_uid    = NULL,
                             staff_role   = NULL,
                             staff_scope  = NULL,
                             p256dh       = EXCLUDED.p256dh,
                             auth         = EXCLUDED.auth,
                             locale       = EXCLUDED.locale,
                             last_used_at = now()""",
                    (household_id, account_id, endpoint, p256dh, auth, locale),
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
def unsubscribe():
    """Drop one browser's subscription.

    Scoped to the caller's own account id as well as the endpoint, on BOTH the citizen and the
    staff column: without that, knowing any endpoint string would let one account silence another
    family's -- or another division's -- notifications.
    """
    claims, error = authenticated_claims()
    if error:
        return error
    account_id = claims.get("sub")
    if not account_id:
        return jsonify({"error": "invalid_token"}), 401

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
                    "DELETE FROM push_subscriptions"
                    " WHERE endpoint = %s AND (citizen_uid = %s OR staff_uid = %s)",
                    (endpoint, account_id, account_id),
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
