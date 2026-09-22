"""AI inference / override research log API (Story 3.4).

POST /api/v1/inference/log — officer-authenticated (Supabase JWT via require_officer(); this
is the FIRST real consumer of the 3.1 middleware). Writes ONE append-only inference_log row
recording the AI's original prediction AND any officer override, for the override-rate metric
(NFR-6.3) and 5-year research retention (NFR-3.4).

Offline seam (Story 3.4): the officer overrides offline, so the frontend does NOT call this
endpoint yet — Story 4.2 (idempotent batch sync) forwards the draft fields here. This endpoint
is delivered now as a verified capability (integration-tested).

officer_id is always taken from the signature-verified JWT (g.officer_id), NEVER from the body.
"""
import uuid

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_officer
from app.infrastructure.inference_log import (  # noqa: F401 - re-exported
    MAX_MODEL_VERSION_LEN,
    MAX_PREDICTION_LEN,
    VALID_CATEGORIES,
    VALID_MODEL_TYPES,
    insert_inference_log,
    parse_classification,
)

inference_bp = Blueprint("inference", __name__)


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@inference_bp.route("/inference/log", methods=["POST"])
@require_officer()
def log_inference():
    officer_id = g.officer_id  # from the verified JWT `sub`, never the request body
    body = request.get_json(silent=True)
    # Body must be a JSON object. A truthy non-object (array/string/number) would otherwise
    # reach `.get()` and raise outside the psycopg2 try/except, escaping as a raw 500 instead
    # of the {"error": ...} 400 contract every other bad-input path returns.
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    offline_id = body.get("offline_id")
    if not isinstance(offline_id, str) or not offline_id:
        return jsonify({"error": "offline_id_required"}), 400
    # cases.offline_id is a UUID column (migration 002); a malformed value would fail the
    # SELECT cast (psycopg2.DataError) → 500. Reject it as a client error up front.
    try:
        uuid.UUID(offline_id)
    except ValueError:
        return jsonify({"error": "invalid_offline_id"}), 400

    fields, error = parse_classification(body)
    if error:
        return jsonify({"error": error}), 400

    # input_features is the research feature snapshot; officer_id lives here for accountability
    # (NFR-3.4) and the override-rate metric — it is never a queryable identity column.
    input_features = {
        "offline_id": offline_id,
        "officer_id": officer_id,
        "ai_severity": body.get("ai_severity"),
        "ai_processing_time_ms": body.get("ai_processing_time_ms"),
    }

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # Resolve case_id from offline_id (NULL until the case itself has synced).
                    cur.execute("SELECT id FROM cases WHERE offline_id = %s", (offline_id,))
                    row = cur.fetchone()
                    case_id = row[0] if row else None

                    insert_inference_log(cur, case_id, fields, input_features)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("inference_log insert failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({"logged": True}), 201
