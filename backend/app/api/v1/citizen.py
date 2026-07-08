"""Citizen "My Cases" API (Story 4.0, NFR-3.2 citizen leg).

GET /api/v1/citizen/cases — citizen-authenticated (Supabase JWT via require_citizen()). Returns the
cases owned by the signed-in citizen (cases.citizen_id = g.citizen_id), newest first. This is the
account "My Cases" list; it is distinct from the public reference-lookup (Story 2.5, FR-6.1), which
stays unauthenticated.

The payload is PII-free: never citizen_nic_plain or submitter_identity_hash (mirrors status.py /
officer.py). citizen_id comes only from the verified JWT, never the request.
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify

from app.api.v1.middleware.auth import require_citizen

citizen_bp = Blueprint("citizen", __name__)

# A personal list, not an export (export is Epic 6) — cap the result set.
MAX_CASES = 200


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@citizen_bp.route("/citizen/cases", methods=["GET"])
@require_citizen()
def list_my_cases():
    citizen_id = g.citizen_id  # verified JWT sub — never from the request

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # Explicit column list (never SELECT *) so PII columns can never leak.
                    cur.execute(
                        """SELECT canonical_id, offline_id, status, damage_category,
                                  submitted_via, submitted_at, updated_at
                             FROM cases
                            WHERE citizen_id = %s
                            ORDER BY submitted_at DESC
                            LIMIT %s""",
                        (citizen_id, MAX_CASES),
                    )
                    rows = cur.fetchall()
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("citizen case list failed")
        return jsonify({"error": "server_error"}), 500

    cases = [
        {
            "canonical_id": r[0],
            "offline_id": str(r[1]) if r[1] is not None else None,
            "status": r[2],
            "damage_category": r[3],
            "submitted_via": r[4],
            "submitted_at": r[5].isoformat() if r[5] else None,
            "updated_at": r[6].isoformat() if r[6] else None,
        }
        for r in rows
    ]
    return jsonify({"cases": cases, "count": len(cases)}), 200
