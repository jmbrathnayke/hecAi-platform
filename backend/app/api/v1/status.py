"""Public claim-status API (Story 2.5).

GET /api/v1/cases/status/<reference> — NO authentication (FR-6.1). Returns ONLY status
metadata (canonical_id, offline_id, status, updated_at, approved_amount). Never NIC,
mobile, GPS, or audit data (CRITICAL #1). A v4 UUID is looked up by offline_id; a
HEC-YYYY-NNNN id by canonical_id (strict patterns, CRITICAL #5).
"""
import re

import psycopg2
from flask import Blueprint, current_app, jsonify

status_bp = Blueprint("status", __name__)

# `fullmatch` is used (not `match`) so these are end-anchored without Python's `$`
# trailing-newline quirk, keeping the backend in lockstep with the frontend regex.
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)
HEC_RE = re.compile(r"HEC-\d{4}-\d+", re.IGNORECASE)


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@status_bp.route("/<string:reference>", methods=["GET"])
def get_status(reference: str):
    if UUID_RE.fullmatch(reference):
        column = "offline_id"
        # offline_id is a Postgres `uuid` column — comparison is case-insensitive.
        lookup = reference
    elif HEC_RE.fullmatch(reference):
        column = "canonical_id"
        # canonical_id is TEXT always stored uppercase (HEC-YYYY-NNNN); normalize so a
        # lower/mixed-case reference does not produce a false 404.
        lookup = reference.upper()
    else:
        return jsonify({"error": "invalid_reference"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # `column` is a fixed identifier chosen by the regex branch above — never
                    # user text — so the f-string is injection-safe; `lookup` is parameterized.
                    cur.execute(
                        f"""SELECT canonical_id, offline_id, status, updated_at, approved_amount
                            FROM cases WHERE {column} = %s""",
                        (lookup,),
                    )
                    row = cur.fetchone()
        finally:
            conn.close()
    except psycopg2.Error:
        # Don't leak DB internals; the client maps this to a generic "try again" message
        # (distinct from a 404, so a valid reference is not mislabeled "not found").
        current_app.logger.exception("status lookup failed for %s", column)
        return jsonify({"error": "server_error"}), 500

    if not row:
        return jsonify({"error": "not_found"}), 404

    canonical_id, offline_id, status, updated_at, approved_amount = row
    response = {
        "canonical_id": canonical_id,
        "offline_id": str(offline_id) if offline_id is not None else None,
        "status": status,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }
    if status == "Approved" and approved_amount is not None:
        response["approved_amount"] = float(approved_amount)

    return jsonify(response), 200
