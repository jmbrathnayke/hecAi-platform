"""Case submission API (Story 2.4).

POST /api/v1/cases/submit — authenticated (Supabase JWT). Stores a citizen's case,
assigns the canonical HEC-YYYY-NNNN id, and writes an append-only audit_log row.
Idempotent on offline_id: a repeated submission returns the same canonical_id (200)
rather than creating a duplicate (CRITICAL #6).
"""
from datetime import datetime, timezone

import jwt
import psycopg2
from flask import Blueprint, current_app, jsonify, request

cases_bp = Blueprint("cases", __name__)


def _verify_jwt(token: str) -> dict:
    secret = current_app.config.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise jwt.InvalidKeyError("SUPABASE_JWT_SECRET not configured")
    return jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False})


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@cases_bp.route("/cases/submit", methods=["POST"])
def submit_case():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "missing_token"}), 401
    try:
        claims = _verify_jwt(auth.split(" ", 1)[1])
    except jwt.PyJWTError:
        return jsonify({"error": "invalid_token"}), 401

    body = request.get_json(silent=True) or {}
    offline_id = body.get("offline_id")
    if not offline_id:
        return jsonify({"error": "offline_id_required"}), 400
    damage_category = body.get("damage_category")
    if not damage_category:
        return jsonify({"error": "damage_category_required"}), 400

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                # Idempotency: an already-submitted offline_id returns its canonical id.
                cur.execute(
                    "SELECT canonical_id FROM cases WHERE offline_id = %s", (offline_id,)
                )
                existing = cur.fetchone()
                if existing:
                    return jsonify({"canonical_id": existing[0], "offline_id": offline_id}), 200

                cur.execute("SELECT nextval('hec_canonical_seq')")
                seq = cur.fetchone()[0]
                year = (body.get("timestamp_local") or "")[:4]
                if not year.isdigit():
                    year = str(datetime.now(timezone.utc).year)
                canonical_id = f"HEC-{year}-{seq:04d}"

                gps = body.get("gps") or {}
                cur.execute(
                    """INSERT INTO cases
                         (offline_id, canonical_id, damage_category,
                          gps_lat, gps_lng, submitter_identity_hash)
                       VALUES (%s, %s, %s, %s, %s, %s)
                       RETURNING id""",
                    (
                        offline_id,
                        canonical_id,
                        damage_category,
                        gps.get("lat"),
                        gps.get("lng"),
                        body.get("submitter_identity_hash"),
                    ),
                )
                case_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO audit_log (case_id, event, actor_id) VALUES (%s, %s, %s)",
                    (case_id, "submitted", claims.get("sub")),
                )
        return jsonify({"canonical_id": canonical_id, "offline_id": offline_id}), 201
    finally:
        conn.close()
