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
import json
import uuid

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_officer
from app.domain.validation import MIN_REASON_LENGTH

inference_bp = Blueprint("inference", __name__)

# The 3 model classes (ClassId). `combined` is a derived case-level rollup, never a per-photo
# class, so it is NOT a valid override target.
VALID_CATEGORIES = {"crop_damage", "no_damage", "property_damage"}

# Known model families (AC5 metric filters on model_type). Anything else is a client error.
VALID_MODEL_TYPES = {"mobilenetv2", "random_forest"}
# Match the inference_log VARCHAR limits (migration 006) so over-length input is a 400 here,
# not a StringDataRightTruncation 500 at INSERT.
MAX_MODEL_VERSION_LEN = 20
MAX_PREDICTION_LEN = 50


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

    model_version = body.get("model_version")
    if not isinstance(model_version, str) or not model_version:
        return jsonify({"error": "model_version_required"}), 400
    if len(model_version) > MAX_MODEL_VERSION_LEN:
        return jsonify({"error": "invalid_model_version"}), 400

    prediction = body.get("prediction")
    if not isinstance(prediction, str) or not prediction:
        return jsonify({"error": "prediction_required"}), 400
    if len(prediction) > MAX_PREDICTION_LEN:
        return jsonify({"error": "invalid_prediction"}), 400

    # model_type defaults to mobilenetv2; only known model families are accepted (they must
    # fit VARCHAR(20) and stay inside the AC5 metric filter).
    model_type = body.get("model_type") or "mobilenetv2"
    if model_type not in VALID_MODEL_TYPES:
        return jsonify({"error": "invalid_model_type"}), 400

    # confidence is an optional 0..1 probability stored in DECIMAL(5,4). Reject bools (bool is
    # an int subclass) and out-of-range values so a client mistake is a 400, not a numeric
    # overflow 500 (or a silently stored impossible probability).
    confidence = body.get("confidence")
    if confidence is not None:
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return jsonify({"error": "invalid_confidence"}), 400
        if not 0 <= confidence <= 1:
            return jsonify({"error": "invalid_confidence"}), 400

    # Only a real JSON boolean counts — bool("false") is True, so coercing here would let a
    # stringy "false" flip into the override branch.
    was_overridden = body.get("was_overridden", False)
    if not isinstance(was_overridden, bool):
        return jsonify({"error": "invalid_was_overridden"}), 400
    override_reason = body.get("override_reason")
    override_category = body.get("override_category")

    if was_overridden:
        # AC7: an override must carry a valid corrected class and a substantive reason.
        if not isinstance(override_category, str) or override_category not in VALID_CATEGORIES:
            return jsonify({"error": "invalid_override_category"}), 400
        if (
            not isinstance(override_reason, str)
            or len(override_reason.strip()) < MIN_REASON_LENGTH
        ):
            return jsonify({"error": "override_reason_too_short"}), 400
        # Store the reason without the surrounding whitespace the client's gate ignores.
        override_reason = override_reason.strip()
        # D1: "correcting" to the class the AI already predicted is not a disagreement — record
        # it as a non-override so the NFR-6.3 override-rate metric stays honest. The reason and
        # category are kept as an audit note.
        if override_category == prediction:
            was_overridden = False
    else:
        # A non-override row carries no override fields.
        override_reason = None
        override_category = None

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

                    cur.execute(
                        """INSERT INTO inference_log
                             (case_id, model_type, model_version, input_features, prediction,
                              confidence, was_overridden, override_reason, override_category)
                           VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s)""",
                        (
                            case_id,
                            model_type,
                            model_version,
                            json.dumps(input_features),
                            prediction,
                            confidence,
                            was_overridden,
                            override_reason,
                            override_category,
                        ),
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("inference_log insert failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({"logged": True}), 201
