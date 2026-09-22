"""Staff account provisioning API (FR-11) — the System Administrator's user management.

    GET    /api/v1/users            list staff accounts and their scopes
    POST   /api/v1/users            create an account with a role and a scope
    PATCH  /api/v1/users/<uid>      change an account's role or scope
    DELETE /api/v1/users/<uid>      remove an account

All four require `system_admin` (require_system_admin), because this is the one API on the
platform that can MANUFACTURE AUTHORITY. Everything else acts within a role; this assigns one.

WHY THE ROLE LIVES IN SUPABASE, NOT IN `users`. The API guards read `app_metadata` out of the
signature-verified JWT (middleware/auth.py), so that is where a role has to be written for it to
mean anything. The `users` table is a vestigial mirror and is deliberately NOT written here — see
the note above _validate_scope for the three reasons, one of which is a type mismatch that would
have failed every administrator creation.

WHY THE SERVICE-ROLE KEY IS REQUIRED. `app_metadata` is writable only with it. That restriction is
exactly what makes the claim trustworthy: it is why a citizen cannot call auth.updateUser() and
name themselves an administrator. Without the key configured this API refuses (503) rather than
degrading to something that appears to work.

THE ESCALATION BOUNDARY, stated because it is the whole point of the module:
  - role must be one of _ROLES; an arbitrary string would become an unguarded claim
  - scope is validated against the district/division reference data, so an account cannot be
    created against a district that does not exist and then silently see nothing
  - a system administrator cannot remove or demote their own account, which would leave the
    deployment with no one able to provision
  - every action is written to the hash-chained audit_log, with case_id NULL: provisioning is not
    an action on a case, but it belongs in the same tamper-evident chain as one
"""
import re
import secrets
import string

import psycopg2
import requests
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_system_admin
from app.infrastructure.audit import write_audit_log
from app.infrastructure.geo.divisions import (
    all_divisions,
    districts,
    is_valid_district,
    is_valid_division,
)

users_bp = Blueprint("users", __name__)

# The only roles this API may assign. An unrecognised string written into app_metadata would not
# match any guard, producing an account that can sign in and do nothing — a support ticket that
# looks like a bug. `citizen` is absent on purpose: citizens self-register and hold no role claim.
_ROLES = ("officer", "admin", "ds_officer", "system_admin")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
_MAX_DIVISIONS = 25
_TIMEOUT = 30


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _admin_api():
    """-> (base_url, headers) for Supabase's Auth Admin API, or (None, None) if unconfigured."""
    url = (current_app.config.get("SUPABASE_URL") or "").rstrip("/")
    key = current_app.config.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None, None
    return url, {"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"}


def _temp_password():
    """A high-entropy first password, shown to the provisioning administrator exactly once.

    Returned in the create response rather than emailed because the deployment has no outbound
    mail provisioned (§7.3). The account holder is expected to change it on first sign-in; this
    value is never stored by the platform and never appears in a log or an audit row.
    """
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(secrets.choice(alphabet) for _ in range(20))


def _clean(value, limit=200):
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed and len(trimmed) <= limit else None


def _validate_scope(role, body):
    """-> (claims dict, error message). Validates the scope against the reference data.

    A scope is not free text. 'Anuradhapura' typed in Latin script, or a division misspelt by one
    character, produces an account whose dashboard is permanently empty — a failure indistinguishable
    from "no cases yet", and one the account holder cannot diagnose. Rejecting it here is the only
    point at which it is cheap to catch.
    """
    if role == "system_admin":
        # Deliberately unscoped: research spans every district, and provisioning is platform-wide.
        return {}, None

    if role == "admin":
        district = _clean(body.get("district_id"))
        if not district:
            return None, "district_id is required for an administrator"
        if not is_valid_district(district):
            return None, (f"unknown district {district!r}. Known districts: "
                          f"{', '.join(districts()[:6])}…")
        return {"district_id": district}, None

    if role == "ds_officer":
        division = _clean(body.get("ds_division"))
        if not division:
            return None, "ds_division is required for a Divisional Secretariat officer"
        if not is_valid_division(division):
            return None, f"unknown DS division {division!r}"
        return {"ds_division": division}, None

    # officer — a list, because a field officer covers several divisions.
    raw = body.get("assigned_divisions")
    if not isinstance(raw, list) or not raw:
        return None, "assigned_divisions must be a non-empty list for a field officer"
    if len(raw) > _MAX_DIVISIONS:
        return None, f"assigned_divisions is capped at {_MAX_DIVISIONS}"
    cleaned = []
    for item in raw:
        name = _clean(item)
        if not name or not is_valid_division(name):
            return None, f"unknown DS division {item!r}"
        if name not in cleaned:
            cleaned.append(name)
    return {"assigned_divisions": cleaned}, None


def _scope_of(meta):
    """-> the human-readable scope of an account, for the list view."""
    if meta.get("district_id"):
        return {"kind": "district", "value": meta["district_id"]}
    if meta.get("ds_division"):
        return {"kind": "ds_division", "value": meta["ds_division"]}
    if meta.get("assigned_divisions"):
        return {"kind": "assigned_divisions", "value": meta["assigned_divisions"]}
    return {"kind": "none", "value": None}


def _shape(user):
    """-> the public shape of an account. No tokens, no password hashes, no provider identities."""
    meta = user.get("app_metadata") or {}
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "role": meta.get("role"),
        "scope": _scope_of(meta),
        "created_at": user.get("created_at"),
        "last_sign_in_at": user.get("last_sign_in_at"),
    }


def _audit(event, metadata):
    """Write a provisioning action into the hash-chained audit_log.

    case_id is NULL: this is not an action on a case. It still belongs in the chain — an account
    that gained an administrator role is exactly the kind of event a tamper-evident log exists to
    make undeniable, and keeping it in the same chain means verify_chain() covers it too.

    Never records the email address or the temporary password. The account id is enough to trace
    the action, and an append-only log read by every administrator is the wrong place for either.
    """
    conn = None
    try:
        conn = _get_connection()
        with conn:
            with conn.cursor() as cur:
                write_audit_log(cur, None, event, g.system_admin_id, metadata)
    except psycopg2.Error:
        # The Supabase write has already happened and cannot be rolled back from here. Losing the
        # audit row is serious enough to log loudly, but failing the request would leave the caller
        # believing the account was not created when it was.
        current_app.logger.exception("provisioning audit write failed for %s", event)
    finally:
        if conn is not None:
            conn.close()


# WHY THIS API DOES NOT WRITE THE `users` TABLE.
#
# The first draft mirrored every provisioned account into `users`, on the reasoning that the table
# exists and should stay in step. Checking what actually reads it changed the decision:
#
#   - nothing in the backend reads it for access or routing
#   - authorization never consults it: every guard reads app_metadata out of the signature-verified
#     JWT, so a row here grants nothing and its absence withholds nothing
#   - `users.district_id` is a bigint, a legacy foreign key, while the administrator claim is a
#     district NAME string — admin.py compares it as `WHERE district = g.district_id`. Writing the
#     claim into the mirror would have raised a type error on every administrator created
#
# So the mirror would have added a failure mode to provisioning in exchange for keeping a column
# nothing reads consistent with a claim it cannot represent. It is left alone, and the JWT remains
# the single source of truth it already was. R-20 records the divergence.


# ---------------------------------------------------------------------------- list
@users_bp.route("/users", methods=["GET"])
@require_system_admin()
def list_users():
    url, headers = _admin_api()
    if not url:
        return jsonify({"error": "provisioning_unavailable"}), 503

    accounts, page = [], 1
    try:
        while page <= 20:
            res = requests.get(f"{url}/auth/v1/admin/users", headers=headers,
                               params={"page": page, "per_page": 200}, timeout=_TIMEOUT)
            if res.status_code != 200:
                current_app.logger.error("admin list failed: HTTP %s", res.status_code)
                return jsonify({"error": "provider_error"}), 502
            batch = res.json().get("users", [])
            if not batch:
                break
            accounts.extend(batch)
            page += 1
    except requests.RequestException:
        current_app.logger.exception("admin list failed")
        return jsonify({"error": "provider_unreachable"}), 502

    # Staff only. Citizens self-register and carry no role claim; listing thousands of them here
    # would turn a provisioning screen into a citizen directory, which is not what it is for.
    staff = [_shape(u) for u in accounts if (u.get("app_metadata") or {}).get("role")]
    staff.sort(key=lambda u: (u["role"] or "", u["email"] or ""))
    # The reference vocabularies ship with the list so the form can offer pickers rather than free
    # text. Without them the only feedback on a scope is a rejection after submitting, and the
    # names are Sinhala — a user typing "Polonnaruwa" has no way to discover "පොළොන්නරුව", nor
    # that it is a district and not a DS division at all.
    return jsonify({
        "users": staff,
        "total": len(staff),
        "districts": districts(),
        "divisions": [{"name": name, "district": district}
                      for name, district in all_divisions()],
    }), 200


# ---------------------------------------------------------------------------- create
@users_bp.route("/users", methods=["POST"])
@require_system_admin()
def create_user():
    url, headers = _admin_api()
    if not url:
        return jsonify({"error": "provisioning_unavailable"}), 503

    body = request.get_json(silent=True) or {}
    email = _clean(body.get("email"))
    role = body.get("role")

    if not email or not _EMAIL_RE.match(email):
        return jsonify({"error": "invalid_email"}), 400
    if role not in _ROLES:
        return jsonify({"error": "invalid_role", "allowed": list(_ROLES)}), 400

    claims, scope_error = _validate_scope(role, body)
    if scope_error:
        return jsonify({"error": "invalid_scope", "detail": scope_error}), 400

    password = _temp_password()
    try:
        res = requests.post(
            f"{url}/auth/v1/admin/users", headers=headers, timeout=_TIMEOUT,
            json={
                "email": email,
                "password": password,
                # Pre-confirmed: the deployment has no outbound mail (§7.3), so an account that
                # waited on a confirmation link would never become usable.
                "email_confirm": True,
                "app_metadata": {"role": role, **claims},
            },
        )
    except requests.RequestException:
        current_app.logger.exception("admin create failed")
        return jsonify({"error": "provider_unreachable"}), 502

    if res.status_code in (422, 409):
        return jsonify({"error": "email_already_exists"}), 409
    if res.status_code not in (200, 201):
        current_app.logger.error("admin create failed: HTTP %s", res.status_code)
        return jsonify({"error": "provider_error"}), 502

    created = res.json()
    uid = created.get("id")
    _audit("staff_account_created", {"account_id": uid, "role": role, **claims})

    payload = _shape(created)
    # Returned ONCE, to the administrator who just created the account, over TLS. Not stored, not
    # logged, not audited. The holder is expected to change it on first sign-in.
    payload["temporary_password"] = password
    return jsonify(payload), 201


# ---------------------------------------------------------------------------- update
@users_bp.route("/users/<string:uid>", methods=["PATCH"])
@require_system_admin()
def update_user(uid):
    if not _UUID_RE.match(uid or ""):
        return jsonify({"error": "invalid_id"}), 400

    url, headers = _admin_api()
    if not url:
        return jsonify({"error": "provisioning_unavailable"}), 503

    body = request.get_json(silent=True) or {}
    role = body.get("role")
    if role not in _ROLES:
        return jsonify({"error": "invalid_role", "allowed": list(_ROLES)}), 400

    # Self-demotion would strip the last provisioning authority from the deployment, and there is
    # no second route back in: app_metadata is not writable from the dashboard.
    if uid == g.system_admin_id and role != "system_admin":
        return jsonify({"error": "cannot_demote_self"}), 409

    claims, scope_error = _validate_scope(role, body)
    if scope_error:
        return jsonify({"error": "invalid_scope", "detail": scope_error}), 400

    try:
        res = requests.put(f"{url}/auth/v1/admin/users/{uid}", headers=headers, timeout=_TIMEOUT,
                           json={"app_metadata": {"role": role, **claims}})
    except requests.RequestException:
        current_app.logger.exception("admin update failed")
        return jsonify({"error": "provider_unreachable"}), 502

    if res.status_code == 404:
        return jsonify({"error": "not_found"}), 404
    if res.status_code != 200:
        current_app.logger.error("admin update failed: HTTP %s", res.status_code)
        return jsonify({"error": "provider_error"}), 502

    _audit("staff_account_updated", {"account_id": uid, "role": role, **claims})
    return jsonify(_shape(res.json())), 200


# ---------------------------------------------------------------------------- delete
@users_bp.route("/users/<string:uid>", methods=["DELETE"])
@require_system_admin()
def delete_user(uid):
    if not _UUID_RE.match(uid or ""):
        return jsonify({"error": "invalid_id"}), 400

    url, headers = _admin_api()
    if not url:
        return jsonify({"error": "provisioning_unavailable"}), 503

    # Same reasoning as demotion, and worse: deleting the last system administrator leaves an
    # otherwise healthy deployment with no way to create one.
    if uid == g.system_admin_id:
        return jsonify({"error": "cannot_delete_self"}), 409

    try:
        res = requests.delete(f"{url}/auth/v1/admin/users/{uid}",
                              headers=headers, timeout=_TIMEOUT)
    except requests.RequestException:
        current_app.logger.exception("admin delete failed")
        return jsonify({"error": "provider_unreachable"}), 502

    if res.status_code == 404:
        return jsonify({"error": "not_found"}), 404
    if res.status_code not in (200, 204):
        current_app.logger.error("admin delete failed: HTTP %s", res.status_code)
        return jsonify({"error": "provider_error"}), 502

    _audit("staff_account_deleted", {"account_id": uid})
    # Cases, audit rows and payment authorisations reference the actor by id and are untouched:
    # deleting the account must not erase what the person did while it existed.
    return jsonify({"deleted": True, "id": uid}), 200
