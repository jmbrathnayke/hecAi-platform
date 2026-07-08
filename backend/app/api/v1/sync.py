"""Idempotent batch sync API (Story 4.2, FR-8.3).

POST /api/v1/sync/batch — officer-authenticated (Supabase JWT via require_officer()).
Serves Story 4.1's already-merged client (frontend/lib/syncQueue.ts::runSync), which may
retry the same offline_id 2-6+ times via exponential backoff or the serwist BackgroundSync
plugin. Each item is upserted with the same offline_id-keyed idempotency guard as
cases.py::submit_case (INSERT ... ON CONFLICT (offline_id) DO NOTHING); a retried item comes
back with inserted: false and its existing canonical_id rather than a duplicate row.

Request/response shape mirrors POST /api/v1/cases/submit exactly (same buildCasePayload()
item shape from frontend/lib/poc.ts), batched under {"cases": [...]}.
"""
import datetime

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_officer

sync_bp = Blueprint("sync", __name__)

MAX_BATCH_SIZE = 50


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _is_number(value) -> bool:
    # bool is a subclass of int in Python — True/False must not pass as coordinates.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_item(item: dict) -> list:
    """No closed enum on damage_category exists anywhere else in this backend, so this
    endpoint doesn't invent one either — but every field is type/range-checked before it
    can reach a typed DB column (a wrong-type or out-of-range value must 400, not crash
    the batch's DB transaction)."""
    errors = []
    if not isinstance(item, dict):
        return ["item must be an object"]

    offline_id = item.get("offline_id")
    if not offline_id:
        errors.append("offline_id is required")
    elif not isinstance(offline_id, str):
        errors.append("offline_id must be a string")

    damage_category = item.get("damage_category")
    if not damage_category:
        errors.append("damage_category is required")
    elif not isinstance(damage_category, str):
        errors.append("damage_category must be a string")

    gps = item.get("gps")
    if gps is not None:
        if not isinstance(gps, dict):
            errors.append("gps must be an object or null")
        else:
            lat, lng = gps.get("lat"), gps.get("lng")
            if lat is not None and (not _is_number(lat) or not (-90 <= lat <= 90)):
                errors.append("gps.lat must be a number in range -90..90")
            if lng is not None and (not _is_number(lng) or not (-180 <= lng <= 180)):
                errors.append("gps.lng must be a number in range -180..180")

    return errors


@sync_bp.route("/batch", methods=["POST"])
@require_officer()
def batch_sync():
    officer_id = g.officer_id  # verified JWT sub — never from the request

    body = request.get_json(silent=True) or {}
    cases_data = body.get("cases")

    if not isinstance(cases_data, list) or len(cases_data) == 0:
        return jsonify({"error": "cases array required"}), 400
    if len(cases_data) > MAX_BATCH_SIZE:
        return jsonify({"error": f"batch size exceeds maximum of {MAX_BATCH_SIZE}"}), 400

    # Validate every item before opening the DB transaction — validation errors must
    # never leave a partial batch committed.
    errors = []
    for item in cases_data:
        field_errors = _validate_item(item)
        if field_errors:
            offline_id = item.get("offline_id", "?") if isinstance(item, dict) else "?"
            errors.append({"offline_id": offline_id, "fields": field_errors})

    if errors:
        return jsonify({"errors": errors}), 400

    conn = _get_connection()
    try:
        results = []
        with conn:
            with conn.cursor() as cur:
                for item in cases_data:
                    results.append(_sync_one(cur, item, officer_id))
        return jsonify({"results": results}), 200
    except psycopg2.Error:
        current_app.logger.exception("sync batch failed")
        return jsonify({"error": "server_error"}), 500
    finally:
        conn.close()


def _sync_one(cur, item: dict, officer_id: str) -> dict:
    offline_id = item["offline_id"]

    # Fast path: an already-synced offline_id returns its canonical id without burning a
    # sequence value (retry scenario — the client may replay this same item repeatedly).
    cur.execute("SELECT canonical_id FROM cases WHERE offline_id = %s", (offline_id,))
    existing = cur.fetchone()
    if existing:
        return {"offline_id": offline_id, "canonical_id": existing[0], "inserted": False}

    ts = item.get("timestamp_local")
    year = ts[:4] if isinstance(ts, str) else ""
    # isdigit() alone accepts non-ASCII digits (e.g. superscripts) and short strings would
    # otherwise slip through as a malformed canonical_id (e.g. "HEC-99-0001").
    if not (len(year) == 4 and year.isascii() and year.isdigit()):
        year = str(datetime.datetime.now(datetime.timezone.utc).year)

    cur.execute("SELECT nextval('hec_canonical_seq')")
    seq = cur.fetchone()[0]
    canonical_id = f"HEC-{year}-{seq:04d}"

    gps = item.get("gps")
    if not isinstance(gps, dict):
        gps = {}

    # officer_id is ALWAYS the verified JWT sub, never trusted from the item body — mirrors
    # cases.py's officer-assisted branch (CRITICAL: prevents an item spoofing another officer).
    submitted_by_officer = item.get("submitted_by_officer") is True
    item_officer_id = officer_id if submitted_by_officer else None

    # Race-safe insert: a concurrent sync of the same offline_id yields no row.
    cur.execute(
        """INSERT INTO cases
             (offline_id, canonical_id, damage_category,
              gps_lat, gps_lng, submitter_identity_hash,
              officer_id, submitted_by_officer)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (offline_id) DO NOTHING
           RETURNING id""",
        (
            offline_id,
            canonical_id,
            item.get("damage_category"),
            gps.get("lat"),
            gps.get("lng"),
            item.get("submitter_identity_hash"),
            item_officer_id,
            submitted_by_officer,
        ),
    )
    row = cur.fetchone()
    if row is None:
        # Lost the race — return the winner's canonical id (idempotent).
        cur.execute("SELECT canonical_id FROM cases WHERE offline_id = %s", (offline_id,))
        won = cur.fetchone()
        return {"offline_id": offline_id, "canonical_id": won[0], "inserted": False}

    case_id = row[0]
    cur.execute(
        "INSERT INTO audit_log (case_id, event, actor_id) VALUES (%s, %s, %s)",
        (case_id, "case_synced", officer_id),
    )
    return {"offline_id": offline_id, "canonical_id": canonical_id, "inserted": True}
