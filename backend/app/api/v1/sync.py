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
from app.infrastructure.audit import write_audit_log
from app.infrastructure.ml import compensation

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


def _floats_differ(a, b) -> bool:
    """Postgres returns NUMERIC as Decimal; compare against a client float with a small
    tolerance so harmless serialization noise on an ordinary retry never reads as a
    collision."""
    if a is None or b is None:
        return a is not b
    return abs(float(a) - float(b)) > 1e-6


def _log_uuid_collision_if_content_differs(cur, existing_row, item, officer_id: str) -> None:
    """Story 4.3 (PRD Addendum A3): a UUID4 collision (~10^-18, essentially never occurs)
    submitted by a different device would hit the same ON CONFLICT path as an ordinary
    retry, but with DIFFERENT content. Log-only, belt-and-suspenders — no new id is minted,
    no second row is inserted, and the original stored case is never modified ("no data is
    lost"). An ordinary same-device retry always resends byte-identical content, so this
    never fires in the common case."""
    existing_id, _canonical_id, existing_damage, existing_lat, existing_lng, existing_hash, existing_officer_id = existing_row

    gps = item.get("gps")
    if not isinstance(gps, dict):
        gps = {}
    submitted_by_officer = item.get("submitted_by_officer") is True
    item_officer_id = officer_id if submitted_by_officer else None

    differs = (
        existing_damage != item.get("damage_category")
        or _floats_differ(existing_lat, gps.get("lat"))
        or _floats_differ(existing_lng, gps.get("lng"))
        or existing_hash != item.get("submitter_identity_hash")
        or existing_officer_id != item_officer_id
    )
    if not differs:
        return

    write_audit_log(
        cur,
        existing_id,
        "uuid_collision",
        officer_id,
        {
            "offline_id": item.get("offline_id"),
            "existing_case_id": existing_id,
            "note": "content differs from stored row with same offline_id",
        },
    )


def _sync_one(cur, item: dict, officer_id: str) -> dict:
    offline_id = item["offline_id"]

    # Fast path: an already-synced offline_id returns its canonical id without burning a
    # sequence value (retry scenario — the client may replay this same item repeatedly).
    # Also fetches content columns for the UUID-collision check below.
    cur.execute(
        "SELECT id, canonical_id, damage_category, gps_lat, gps_lng, "
        "submitter_identity_hash, officer_id FROM cases WHERE offline_id = %s",
        (offline_id,),
    )
    existing = cur.fetchone()
    if existing:
        _log_uuid_collision_if_content_differs(cur, existing, item, officer_id)
        return {"offline_id": offline_id, "canonical_id": existing[1], "inserted": False}

    ts = item.get("timestamp_local")
    year = ts[:4] if isinstance(ts, str) else ""
    # isdigit() alone accepts non-ASCII digits (e.g. superscripts) and short strings would
    # otherwise slip through as a malformed canonical_id (e.g. "HEC-99-0001").
    if not (len(year) == 4 and year.isascii() and year.isdigit()):
        year = str(datetime.datetime.now(datetime.timezone.utc).year)

    # Single global sequence, never reset per calendar year (PRD Addendum A3 / Story 4.3
    # decision): gap-free numbering matters more than year-local numbering. A case synced
    # in January 2027 can legitimately be HEC-2027-1042, continuing from HEC-2026-1041 —
    # matches the same sequence already shared with cases.py::submit_case and sms.py.
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

    # District/DS-division picker (Story 5.2 Task 7) and AI severity (Task 8) -- both
    # optional, additive fields on the synced item, same shape as the one-shot submit path.
    district = item.get("district")
    district = district if isinstance(district, str) and district else None
    ds_division = item.get("ds_division")
    ds_division = ds_division if isinstance(ds_division, str) and ds_division else None
    ai_severity = item.get("ai_severity")
    ai_severity = ai_severity if isinstance(ai_severity, str) and ai_severity else None

    # Case locale for notifications (Story 5.6, FR-6.3, OQ-B)
    locale = item.get("locale")
    locale = locale if isinstance(locale, str) and locale in ("si", "ta", "en") else "si"

    # Race-safe insert: a concurrent sync of the same offline_id yields no row.
    cur.execute(
        """INSERT INTO cases
             (offline_id, canonical_id, damage_category,
              gps_lat, gps_lng, submitter_identity_hash,
              officer_id, submitted_by_officer, district, ds_division_id, locale)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            district,
            ds_division,
            locale,
        ),
    )
    row = cur.fetchone()
    if row is None:
        # Lost the race — this IS the genuine concurrent-collision scenario (two requests
        # for the same offline_id racing each other); run the same collision check as the
        # fast path so a true collision here isn't silently skipped.
        cur.execute(
            "SELECT id, canonical_id, damage_category, gps_lat, gps_lng, "
            "submitter_identity_hash, officer_id FROM cases WHERE offline_id = %s",
            (offline_id,),
        )
        won = cur.fetchone()
        _log_uuid_collision_if_content_differs(cur, won, item, officer_id)
        return {"offline_id": offline_id, "canonical_id": won[1], "inserted": False}

    case_id = row[0]
    write_audit_log(cur, case_id, "case_synced", officer_id)
    compensation.estimate_and_store(
        cur, case_id, item.get("damage_category"), ds_division,
        datetime.datetime.now(datetime.timezone.utc),
        district=district, ai_severity=ai_severity,
    )
    return {"offline_id": offline_id, "canonical_id": canonical_id, "inserted": True}
