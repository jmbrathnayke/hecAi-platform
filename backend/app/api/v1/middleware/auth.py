"""Officer auth middleware (Story 3.1).

`require_officer()` independently decodes and validates the Supabase JWT server-side —
per CRITICAL #2, the frontend's `assigned_divisions` claim is never trusted directly;
every officer-scoped route re-derives it here from a signature-verified token.

AUTHORIZATION CLAIMS LIVE IN `app_metadata`, NOT `user_metadata` (fixed 2026-08-11).
A signature-verified token is not the same thing as a trustworthy one. Supabase lets any
authenticated client rewrite its OWN `user_metadata` through `auth.updateUser()`, and the
result is signed by Supabase like any other claim — so while these guards read `role` from
there, a citizen could set `{"role": "system_admin"}` on themselves and walk into
/research/export with a perfectly valid signature. `app_metadata` is writable only with the
service-role key, which never leaves the server, so it is the only metadata field that can
carry an authorization decision. `district_id` and `assigned_divisions` move with it: they
are not descriptive, they decide WHICH district's data you can read.

There is deliberately NO fallback to `user_metadata` — a fallback would restore exactly the
escalation path this closes. Existing Supabase users must be migrated before their tokens
authorize anything again; see backend/scripts/migrate_auth_metadata.py.
"""
import functools

import jwt
from flask import current_app, g, jsonify, request

# The single claim these guards trust for authorization.
AUTHZ_CLAIM = "app_metadata"


def authz_metadata(claims):
    """The server-controlled metadata dict, or {} if absent/malformed."""
    metadata = claims.get(AUTHZ_CLAIM)
    return metadata if isinstance(metadata, dict) else {}


def authz_role(claims):
    """The caller's role, or None. Never falls back to client-writable `user_metadata`."""
    role = authz_metadata(claims).get("role")
    return role if isinstance(role, str) else None


def require_officer():
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            secret = current_app.config.get("SUPABASE_JWT_SECRET")
            if not secret:
                # Server misconfiguration, not a client auth problem — mirrors cases.py.
                return jsonify({"error": "server_misconfigured"}), 500

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return jsonify({"error": "missing_token"}), 401
            token = auth.split(" ", 1)[1]
            try:
                claims = jwt.decode(
                    token, secret, algorithms=["HS256"], options={"verify_aud": False}
                )
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "token_expired"}), 401
            except jwt.PyJWTError:
                return jsonify({"error": "invalid_token"}), 401

            metadata = authz_metadata(claims)
            if authz_role(claims) != "officer":
                return jsonify({"error": "forbidden"}), 403

            officer_id = claims.get("sub")
            if not officer_id:
                # A validly-signed token missing `sub` is malformed, not just unauthorized —
                # don't let a None officer_id silently flow into downstream officer_id-keyed
                # queries/audit writes.
                return jsonify({"error": "invalid_token"}), 401

            assigned_divisions = metadata.get("assigned_divisions", [])
            if not isinstance(assigned_divisions, list):
                assigned_divisions = []
            g.officer_id = officer_id
            g.assigned_divisions = [d for d in assigned_divisions if isinstance(d, str)]
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_admin():
    """Guard admin-owned routes (Story 5.1). Mirrors require_officer()'s independent JWT
    validation and error-code conventions; a district admin's `district_id` is never trusted
    from the client — every admin-scoped route re-derives it here from a signature-verified
    token."""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            secret = current_app.config.get("SUPABASE_JWT_SECRET")
            if not secret:
                return jsonify({"error": "server_misconfigured"}), 500

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return jsonify({"error": "missing_token"}), 401
            token = auth.split(" ", 1)[1]
            try:
                claims = jwt.decode(
                    token, secret, algorithms=["HS256"], options={"verify_aud": False}
                )
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "token_expired"}), 401
            except jwt.PyJWTError:
                return jsonify({"error": "invalid_token"}), 401

            metadata = authz_metadata(claims)
            if authz_role(claims) != "admin":
                # An officer token (or any non-admin) must never grant admin access.
                return jsonify({"error": "forbidden"}), 403

            admin_id = claims.get("sub")
            if not admin_id:
                # A validly-signed token missing `sub` is malformed — don't let a None admin_id
                # flow into district-scoped queries/audit writes.
                return jsonify({"error": "invalid_token"}), 401

            district_id = metadata.get("district_id")
            g.admin_id = admin_id
            # A malformed claim (array/object/number) must not flow unchecked toward future
            # district-scoped queries/audit writes (code review 2026-07-09) — mirrors the
            # frontend's useAdminSession coercion of the same claim.
            g.district_id = district_id if isinstance(district_id, str) else None
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_research():
    """Guard the researcher-scoped export (Story 7.3, FR-7.3). Mirrors require_admin()'s
    independent JWT validation and error-code conventions.

    `system_admin` is introduced by this story (PO decision, OQ-A 2026-08-09). Authorization is
    the signature-verified JWT, so no migration is required for this guard to work: the `users`
    table is a durable mirror of Supabase's role claims, not the auth source — and its
    CHECK (role IN ('officer','admin')) means a system_admin simply has no `users` row today.

    RESOLVED 2026-08-11: this role was previously read from client-writable `user_metadata`,
    which meant any authenticated citizen could self-assign `system_admin` via
    `auth.updateUser()` and export the entire research corpus. It now comes from
    `app_metadata` (module docstring), closing the condition that gated a public HTTPS deploy.

    Deliberately does NOT set a district scope: research spans every district, unlike
    require_admin()'s g.district_id.
    """
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            secret = current_app.config.get("SUPABASE_JWT_SECRET")
            if not secret:
                return jsonify({"error": "server_misconfigured"}), 500

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return jsonify({"error": "missing_token"}), 401
            token = auth.split(" ", 1)[1]
            try:
                claims = jwt.decode(
                    token, secret, algorithms=["HS256"], options={"verify_aud": False}
                )
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "token_expired"}), 401
            except jwt.PyJWTError:
                return jsonify({"error": "invalid_token"}), 401

            if authz_role(claims) != "system_admin":
                # An officer or DISTRICT-admin token must never reach the research corpus:
                # unlike /admin/export it is not district-scoped, so a district admin would
                # otherwise read every district's data through this route.
                return jsonify({"error": "forbidden"}), 403

            researcher_id = claims.get("sub")
            if not researcher_id:
                # A validly-signed token missing `sub` is malformed — don't let a None actor_id
                # flow into the audit row for a bulk data egress.
                return jsonify({"error": "invalid_token"}), 401

            g.researcher_id = researcher_id
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_citizen():
    """Guard citizen-owned routes (Story 4.0). Mirrors require_officer()'s independent JWT
    validation, but a citizen is a plain authenticated Supabase user with NO staff role: any
    officer/admin token is rejected (403) so a staff `sub` is never treated as a citizen_id.
    Sets g.citizen_id from the signature-verified `sub`."""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            secret = current_app.config.get("SUPABASE_JWT_SECRET")
            if not secret:
                return jsonify({"error": "server_misconfigured"}), 500

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return jsonify({"error": "missing_token"}), 401
            token = auth.split(" ", 1)[1]
            try:
                claims = jwt.decode(
                    token, secret, algorithms=["HS256"], options={"verify_aud": False}
                )
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "token_expired"}), 401
            except jwt.PyJWTError:
                return jsonify({"error": "invalid_token"}), 401

            # Staff detection stays on the same authoritative claim. Reading it from
            # `user_metadata` here would let a staff member hide their role to be treated as a
            # citizen — the mirror image of the escalation, and it would attach their staff
            # `sub` to citizen-owned rows.
            if authz_role(claims) in ("officer", "admin", "system_admin"):
                # A valid Supabase token, but staff — not a citizen. Never scope their cases here.
                return jsonify({"error": "forbidden"}), 403

            citizen_id = claims.get("sub")
            if not citizen_id:
                # A validly-signed token missing `sub` is malformed — don't let a None citizen_id
                # flow into ownership-keyed queries.
                return jsonify({"error": "invalid_token"}), 401

            g.citizen_id = citizen_id
            return f(*args, **kwargs)

        return wrapper

    return decorator
