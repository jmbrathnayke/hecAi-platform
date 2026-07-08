"""Officer dashboard case-list API (Story 3.7, NFR-3.2 / NFR-3.4).

GET /api/v1/officer/cases — officer-authenticated (Supabase JWT via require_officer(); this is the
FIRST read-side consumer of that middleware — Story 3.4's inference log was the first write-side
consumer). Returns the cases within the officer's scope, and records the view in audit_log.

Scope (Story 3.1 AC5): a case is visible when
    officer_id = g.officer_id  OR  (ds_division_id IS NOT NULL AND ds_division_id = ANY(g.assigned_divisions))
ds_division_id is a nullable hook (migration 010); nothing populates it yet, so today this is
effectively the officer's own submitted cases, with the division branch wired for when cases carry
a division. officer_id / assigned_divisions come ONLY from the verified JWT (g.*), never the request.

The payload is PII-free: it never includes citizen_nic_plain or submitter_identity_hash (mirrors
the status.py rule).
"""
import json

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_officer

officer_bp = Blueprint("officer", __name__)

# A scoped list, not an export (export is Epic 6) — cap the result set.
MAX_CASES = 200


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _client_ip() -> str:
    """First hop of X-Forwarded-For (real client behind a proxy/ngrok/Render), else remote_addr."""
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or ""


@officer_bp.route("/officer/cases", methods=["GET"])
@require_officer()
def list_cases():
    officer_id = g.officer_id  # verified JWT sub — never from the request
    divisions = g.assigned_divisions  # already a clean list[str] from require_officer()

    # Optional status filter. Passed through as an equality match; an unknown value simply yields
    # no rows (never a 500). NULL sentinel means "no filter".
    status_filter = request.args.get("status") or None

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # Explicit column list (never SELECT *) so PII columns can never leak (AC3).
                    cur.execute(
                        """SELECT canonical_id, offline_id, status, damage_category,
                                  submitted_via, gps_lat, gps_lng, submitted_at, updated_at
                             FROM cases
                            WHERE (officer_id = %s
                                   OR (ds_division_id IS NOT NULL AND ds_division_id = ANY(%s)))
                              AND (%s IS NULL OR status = %s)
                            ORDER BY submitted_at DESC
                            LIMIT %s""",
                        (officer_id, divisions, status_filter, status_filter, MAX_CASES),
                    )
                    rows = cur.fetchall()

                    cases = [
                        {
                            "canonical_id": r[0],
                            "offline_id": str(r[1]) if r[1] is not None else None,
                            "status": r[2],
                            "damage_category": r[3],
                            "submitted_via": r[4],
                            "gps_lat": float(r[5]) if r[5] is not None else None,
                            "gps_lng": float(r[6]) if r[6] is not None else None,
                            "submitted_at": r[7].isoformat() if r[7] else None,
                            "updated_at": r[8].isoformat() if r[8] else None,
                        }
                        for r in rows
                    ]

                    # AC5 (NFR-3.4): record the officer-action (a read) in the audit log. case_id is
                    # NULL — this event is not about a single case. ip_address lives in metadata.
                    cur.execute(
                        "INSERT INTO audit_log (case_id, event, actor_id, metadata) "
                        "VALUES (NULL, %s, %s, %s::jsonb)",
                        (
                            "officer_viewed_cases",
                            officer_id,
                            json.dumps({"ip_address": _client_ip(), "result_count": len(cases)}),
                        ),
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("officer case list failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({"cases": cases, "count": len(cases)}), 200
