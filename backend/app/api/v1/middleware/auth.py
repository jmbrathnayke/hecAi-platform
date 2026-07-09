"""Officer auth middleware (Story 3.1).

`require_officer()` independently decodes and validates the Supabase JWT server-side —
per CRITICAL #2, the frontend's `assigned_divisions` claim is never trusted directly;
every officer-scoped route re-derives it here from a signature-verified token.
"""
import functools

import jwt
from flask import current_app, g, jsonify, request


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

            metadata = claims.get("user_metadata", {})
            if not isinstance(metadata, dict) or metadata.get("role") != "officer":
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

            metadata = claims.get("user_metadata", {})
            if not isinstance(metadata, dict) or metadata.get("role") != "admin":
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

            metadata = claims.get("user_metadata", {})
            role = metadata.get("role") if isinstance(metadata, dict) else None
            if role in ("officer", "admin"):
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
