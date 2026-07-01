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

            assigned_divisions = metadata.get("assigned_divisions", [])
            g.officer_id = claims.get("sub")
            g.assigned_divisions = (
                assigned_divisions if isinstance(assigned_divisions, list) else []
            )
            return f(*args, **kwargs)

        return wrapper

    return decorator
