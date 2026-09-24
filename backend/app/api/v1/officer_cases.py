"""Officer case review: the connection from a citizen's report to the officer's AI assessment.

    GET  /api/v1/officer/cases/<ref>               the case, for the responsible area officer
    POST /api/v1/officer/cases/<ref>/start-review  take responsibility; citizen is told "Under Review"
    POST /api/v1/officer/cases/<ref>/assessment    record the on-device AI assessment for THIS case

WHAT WAS MISSING. A citizen's report reached the officers of its DS division as a push notification
(FR-6.4), but nothing connected the notification to the officer's classification screen: the list
had no case view, and /officer/classify built a brand-new draft rather than assessing an existing
case. The AI assessment therefore could never be attached to the citizen's claim, and the
administrator approved citizen cases nobody had verified.

WHAT THE OFFICER CLASSIFIES. The officer's OWN verification image, captured in the field and
classified by MobileNetV2 in the officer's browser. The citizen's photo is not uploaded and is not
the input here: no image reaches this server at all. Only the classification result does, and it is
recorded through the same research log as every other classification (inference_log, migration 006,
validated by inference.parse_classification).

THE ESTIMATE IS DECISION SUPPORT. The officer's assessment regenerates the Random Forest estimate
with the on-device severity the citizen submission could not supply. It is labelled and audited as an
AI-assisted estimate; the DWC administrator approves, and the Divisional Secretariat makes the final
compensation decision (ds.py). Nothing here decides an amount.

SCOPE. Exactly officer.py's list rule, from the verified JWT only: a case is visible when the officer
submitted it, or its DS division is one of the officer's assigned divisions. A case outside that
scope is a 404, never a 403, so its existence is not confirmed.

PII. Never submitter_identity_hash, any NIC digest or any contact detail in a response.
"""
import re

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_officer
from app.domain.workflow import workflow_stage
from app.infrastructure.audit import write_audit_log
from app.infrastructure.inference_log import insert_inference_log, parse_classification
from app.infrastructure.ml import compensation
from app.infrastructure.notifications import notify_status_change_all
from app.infrastructure.push.push_service import notify_staff_push

officer_cases_bp = Blueprint("officer_cases", __name__)

HEC_RE = re.compile(r"HEC-\d{4}-\d+", re.IGNORECASE)

# The statuses in which a field officer still has work to do on a case.
OPEN_STATUSES = ("Submitted", "Under Review")

# Template key of the citizen notification sent when the assessment is complete (migration 033).
ASSESSMENT_COMPLETE_EVENT = "Assessment Complete"

VALID_SEVERITIES = {"None", "Minor", "Moderate", "Severe"}

# On-device class -> the case damage category the estimator reads (compensation._DAMAGE_TYPE_MAP).
_CLASS_TO_CATEGORY = {"crop_damage": "crop", "property_damage": "property", "no_damage": "none"}

MAX_HISTORY_ROWS = 100

# Column order is shared by every read below; positions are named once here.
_CASE_COLUMNS = """c.id, c.canonical_id, c.offline_id, c.status, c.damage_category,
                   c.gps_lat, c.gps_lng, c.submitted_at, c.updated_at, c.submitted_via,
                   c.submitted_by_officer, c.district, c.ds_division_id, h.household_ref,
                   c.assigned_officer_id, c.officer_review_started_at, c.officer_assessed_at,
                   c.officer_assessed_by"""
(_ID, _REF, _OFFLINE, _STATUS, _CATEGORY, _LAT, _LNG, _SUBMITTED, _UPDATED, _VIA, _BY_OFFICER,
 _DISTRICT, _DIVISION, _HOUSEHOLD, _ASSIGNED, _REVIEW_AT, _ASSESSED_AT, _ASSESSED_BY,
) = range(18)


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _load_case(cur, reference, for_update=False):
    """The case row, if it is inside this officer's scope. None otherwise (never distinguished)."""
    lock = " FOR UPDATE OF c" if for_update else ""
    cur.execute(
        f"""SELECT {_CASE_COLUMNS}
              FROM cases c
              LEFT JOIN households h ON h.id = c.household_id
             WHERE c.canonical_id = %s
               AND (c.officer_id = %s
                    OR (c.ds_division_id IS NOT NULL AND c.ds_division_id = ANY(%s))){lock}""",
        (reference.upper(), g.officer_id, g.assigned_divisions),
    )
    return cur.fetchone()


def _iso(value):
    return value.isoformat() if value else None


def _detail_payload(cur, row):
    """The officer's view of one case. Reads the latest classification, the current AI-assisted
    estimate and the case's event history; writes nothing."""
    case_id = row[_ID]

    cur.execute(
        """SELECT prediction, confidence, was_overridden, override_category, model_version,
                  input_features, created_at
             FROM inference_log WHERE case_id = %s
            ORDER BY created_at DESC, id DESC LIMIT 1""",
        (case_id,),
    )
    ai = cur.fetchone()

    cur.execute(
        """SELECT amount_lkr, raw_estimate_lkr, capped, model_version, created_at
             FROM compensation_estimates WHERE case_id = %s""",
        (case_id,),
    )
    est = cur.fetchone()

    # Event names and times only. Actor ids and metadata stay on the administrator's audit view:
    # an officer needs to see what has happened to a case, not who else touched it.
    cur.execute(
        """SELECT event, created_at FROM audit_log WHERE case_id = %s
            ORDER BY id DESC LIMIT %s""",
        (case_id, MAX_HISTORY_ROWS),
    )
    history = [{"event": e, "created_at": _iso(t)} for e, t in reversed(cur.fetchall())]

    status = row[_STATUS]
    assessed = row[_ASSESSED_AT] is not None
    open_case = status in OPEN_STATUSES
    return {
        "case": {
            "canonical_id": row[_REF],
            "offline_id": str(row[_OFFLINE]) if row[_OFFLINE] is not None else None,
            "status": status,
            "damage_category": row[_CATEGORY],
            "gps_lat": float(row[_LAT]) if row[_LAT] is not None else None,
            "gps_lng": float(row[_LNG]) if row[_LNG] is not None else None,
            "submitted_at": _iso(row[_SUBMITTED]),
            "updated_at": _iso(row[_UPDATED]),
            "submitted_via": row[_VIA],
            "submitted_by_officer": bool(row[_BY_OFFICER]),
            "district": row[_DISTRICT],
            "ds_division": row[_DIVISION],
            "household_ref": row[_HOUSEHOLD],
        },
        "workflow": {
            "stage": workflow_stage(status, row[_REVIEW_AT], row[_ASSESSED_AT], None,
                                    bool(row[_BY_OFFICER])),
            "assigned_officer_id": row[_ASSIGNED],
            "assigned_to_me": row[_ASSIGNED] == g.officer_id,
            "officer_review_started_at": _iso(row[_REVIEW_AT]),
            "officer_assessed_at": _iso(row[_ASSESSED_AT]),
            "assessed_by_me": row[_ASSESSED_BY] == g.officer_id,
        },
        "ai_result": None if ai is None else {
            "prediction": ai[0],
            "confidence": float(ai[1]) if ai[1] is not None else None,
            "was_overridden": bool(ai[2]),
            "override_category": ai[3],
            "model_version": ai[4],
            "ai_severity": (ai[5] or {}).get("ai_severity") if isinstance(ai[5], dict) else None,
            "created_at": _iso(ai[6]),
        },
        # Named for what it is. The UI labels it "AI-Assisted Compensation Estimate"; the final
        # amount is decided by the Divisional Secretariat, never here.
        "ai_assisted_estimate": None if est is None else {
            "amount_lkr": float(est[0]),
            "raw_estimate_lkr": float(est[1]),
            "capped": bool(est[2]),
            "model_version": est[3],
            "created_at": _iso(est[4]),
            "is_final_decision": False,
            "decision_support_only": True,
            # True when the crop model priced it. Surfaced beside the amount so the officer who
            # produced the assessment sees the same provenance the administrator will.
            "synthetic_model": str(est[3] or "").startswith("synthetic_"),
        },
        "history": history,
        "actions": {
            "can_start_review": status == "Submitted",
            "can_assess": open_case,
            "already_assessed": assessed,
        },
    }


def _reload(cur, reference):
    row = _load_case(cur, reference)
    return _detail_payload(cur, row)


@officer_cases_bp.route("/officer/cases/<string:reference>", methods=["GET"])
@require_officer()
def get_case(reference):
    if not HEC_RE.fullmatch(reference):
        return jsonify({"error": "invalid_reference"}), 400
    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    row = _load_case(cur, reference)
                    if row is None:
                        return jsonify({"error": "not_found"}), 404
                    payload = _detail_payload(cur, row)
                    # NFR-3.4: a read of one case is an access event, recorded against the case.
                    write_audit_log(cur, row[_ID], "officer_viewed_case", g.officer_id,
                                    {"ds_division": row[_DIVISION]})
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("officer case detail failed")
        return jsonify({"error": "server_error"}), 500
    return jsonify(payload), 200


@officer_cases_bp.route("/officer/cases/<string:reference>/start-review", methods=["POST"])
@require_officer()
def start_review(reference):
    """The area officer takes responsibility for a citizen's report.

    Idempotent: a second call by any officer on a case already under review changes nothing and
    notifies nobody. The first officer to start the review is recorded as the responsible officer;
    a later officer never silently replaces them (COALESCE), so accountability cannot be reassigned
    by a double-click on another device.
    """
    if not HEC_RE.fullmatch(reference):
        return jsonify({"error": "invalid_reference"}), 400
    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    row = _load_case(cur, reference, for_update=True)
                    if row is None:
                        return jsonify({"error": "not_found"}), 404
                    status = row[_STATUS]
                    if status not in OPEN_STATUSES:
                        return jsonify({"error": "case_not_open", "status": status}), 409

                    if row[_REVIEW_AT] is None or status == "Submitted":
                        cur.execute(
                            """UPDATE cases
                                  SET status = 'Under Review',
                                      assigned_officer_id = COALESCE(assigned_officer_id, %s),
                                      officer_review_started_at = COALESCE(officer_review_started_at, now()),
                                      updated_at = now()
                                WHERE id = %s""",
                            (g.officer_id, row[_ID]),
                        )
                        write_audit_log(cur, row[_ID], "officer_review_started", g.officer_id,
                                        {"ds_division": row[_DIVISION],
                                         "previous_status": status})
                        if status == "Submitted":
                            # The citizen's first sign that a person is now handling the claim.
                            notify_status_change_all(cur, row[_ID], row[_REF],
                                                     "Under Review", g.officer_id)
                    payload = _reload(cur, reference)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("officer start review failed")
        return jsonify({"error": "server_error"}), 500
    return jsonify(payload), 200


@officer_cases_bp.route("/officer/cases/<string:reference>/assessment", methods=["POST"])
@require_officer()
def record_assessment(reference):
    """Record the officer's on-device AI assessment for THIS case and regenerate the estimate."""
    if not HEC_RE.fullmatch(reference):
        return jsonify({"error": "invalid_reference"}), 400

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    fields, error = parse_classification(body)
    if error:
        return jsonify({"error": error}), 400
    if fields["prediction"] not in _CLASS_TO_CATEGORY:
        # inference_log accepts any short label for research; a CASE assessment must be one of the
        # model's three classes, because the class decides which estimate is regenerated.
        return jsonify({"error": "invalid_prediction"}), 400

    ai_severity = body.get("ai_severity")
    if ai_severity is not None and ai_severity not in VALID_SEVERITIES:
        return jsonify({"error": "invalid_ai_severity"}), 400

    processing_ms = body.get("ai_processing_time_ms")
    if processing_ms is not None and (isinstance(processing_ms, bool)
                                      or not isinstance(processing_ms, (int, float))
                                      or processing_ms < 0):
        return jsonify({"error": "invalid_processing_time"}), 400

    final_class = fields["override_category"] if fields["was_overridden"] else fields["prediction"]

    # Crop assessment (Story 5.2b). Validated against the SETTLED class, so an officer who overrides
    # a property prediction to crop_damage is held to the same requirement as one the classifier
    # agreed with -- the override is the officer's judgement and carries the same obligations.
    #
    # REFUSED, NOT SILENTLY DOWNGRADED. Before the crop model existed, a crop report with no crop
    # type was priced by the property model; that is still the fallback for cases submitted earlier,
    # but an officer filing a NEW crop assessment must name the crop. Accepting the assessment and
    # quietly routing it to a model trained on death and property claims is exactly the failure this
    # work exists to remove, so it is a 400 rather than a fallback.
    crop_type = body.get("crop_type")
    affected_area_acres = body.get("affected_area_acres")
    damage_extent_percent = body.get("damage_extent_percent")

    if final_class == "crop_damage":
        if crop_type not in compensation.CROP_TYPES:
            return jsonify({"error": "crop_type_required",
                            "allowed": list(compensation.CROP_TYPES)}), 400
        if compensation._crop_inputs(crop_type, affected_area_acres,
                                     damage_extent_percent) is None:
            return jsonify({"error": "invalid_crop_assessment",
                            "detail": "affected_area_acres and damage_extent_percent must be "
                                      "positive numbers within range"}), 400
    else:
        # A crop type sent with a property or no-damage assessment is discarded rather than stored.
        # Keeping it would leave a crop recorded against a case the crop model must never price.
        crop_type = affected_area_acres = damage_extent_percent = None

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    row = _load_case(cur, reference, for_update=True)
                    if row is None:
                        return jsonify({"error": "not_found"}), 404
                    status = row[_STATUS]
                    if status not in OPEN_STATUSES:
                        # Once the administrator has decided, the officer's assessment is part of
                        # the record that decision rested on and must not change beneath it.
                        return jsonify({"error": "case_not_open", "status": status}), 409

                    case_id = row[_ID]
                    first_assessment = row[_ASSESSED_AT] is None

                    insert_inference_log(cur, case_id, fields, {
                        "offline_id": str(row[_OFFLINE]) if row[_OFFLINE] is not None else None,
                        "officer_id": g.officer_id,
                        "ai_severity": ai_severity,
                        "ai_processing_time_ms": processing_ms,
                        "source": "officer_case_assessment",
                    })

                    if row[_REVIEW_AT] is None:
                        write_audit_log(cur, case_id, "officer_review_started", g.officer_id,
                                        {"ds_division": row[_DIVISION], "previous_status": status})

                    cur.execute(
                        """UPDATE cases
                              SET status = 'Under Review',
                                  assigned_officer_id = COALESCE(assigned_officer_id, %s),
                                  officer_review_started_at = COALESCE(officer_review_started_at, now()),
                                  officer_assessed_at = now(),
                                  officer_assessed_by = %s,
                                  crop_type = %s,
                                  affected_area_acres = %s,
                                  damage_extent_percent = %s,
                                  updated_at = now()
                            WHERE id = %s""",
                        (g.officer_id, g.officer_id, crop_type, affected_area_acres,
                         damage_extent_percent, case_id),
                    )
                    if crop_type is not None:
                        # The crop is the officer's identification, not the AI's, and the audit
                        # trail has to say so -- "whether, not what" still holds, but which of five
                        # crops was chosen is an assessment decision, not citizen data.
                        write_audit_log(cur, case_id, "crop_type_selected", g.officer_id, {
                            "crop_type": crop_type,
                            "affected_area_acres": affected_area_acres,
                            "damage_extent_percent": damage_extent_percent,
                            "source": "officer_declared",
                        })
                    write_audit_log(cur, case_id, "officer_assessment_recorded", g.officer_id, {
                        "prediction": fields["prediction"],
                        "confidence": fields["confidence"],
                        "was_overridden": fields["was_overridden"],
                        "override_category": fields["override_category"],
                        "final_category": final_class,
                        "ai_severity": ai_severity,
                        "model_version": fields["model_version"],
                        "reassessment": not first_assessment,
                    })

                    cur.execute("SELECT amount_lkr FROM compensation_estimates WHERE case_id = %s",
                                (case_id,))
                    previous = cur.fetchone()
                    previous_amount = float(previous[0]) if previous else None

                    category = _CLASS_TO_CATEGORY[final_class]
                    if category == "none":
                        # No damage confirmed by the officer: there is nothing for the estimator to
                        # price. The earlier figure (if any) is left for the administrator to see
                        # against the officer's "no damage" finding -- recorded, not hidden.
                        write_audit_log(cur, case_id, "compensation_estimate_not_regenerated",
                                        g.officer_id, {"reason": "officer_classified_no_damage",
                                                       "previous_amount_lkr": previous_amount})
                    else:
                        estimate = compensation.estimate_and_store(
                            cur, case_id, category, row[_DIVISION], row[_SUBMITTED],
                            district=row[_DISTRICT], ai_severity=ai_severity, replace=True,
                            crop_type=crop_type, affected_area_acres=affected_area_acres,
                            damage_extent_percent=damage_extent_percent,
                        )
                        if estimate is None:
                            write_audit_log(cur, case_id, "compensation_estimate_unavailable",
                                            g.officer_id, {"trigger": "officer_assessment"})
                        else:
                            # Two event names, one for each model, so the audit trail can be read
                            # for "which cases were priced by the synthetic prototype" without
                            # parsing model_version strings. The payload is identical.
                            event = ("crop_compensation_estimate_generated"
                                     if estimate["synthetic_model"]
                                     else "compensation_estimate_generated")
                            write_audit_log(cur, case_id, event, g.officer_id, {
                                "trigger": "officer_assessment",
                                "amount_lkr": estimate["amount_lkr"],
                                "raw_estimate_lkr": estimate["raw_estimate_lkr"],
                                "capped": estimate["capped"],
                                "model_version": estimate["model_version"],
                                "synthetic_model": estimate["synthetic_model"],
                                "crop_type": crop_type,
                                "ai_severity": ai_severity,
                                "previous_amount_lkr": previous_amount,
                                "decision_support_only": True,
                                "is_final_decision": False,
                            })

                    # The administrator is told on every assessment (a reassessment can change the
                    # estimate they are about to review); the citizen only on the first.
                    notify_staff_push(cur, case_id, "assessment_complete", "admin",
                                      row[_DISTRICT], row[_REF], g.officer_id)
                    if first_assessment:
                        notify_status_change_all(cur, case_id, row[_REF],
                                                 ASSESSMENT_COMPLETE_EVENT, g.officer_id)

                    payload = _reload(cur, reference)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("officer assessment failed")
        return jsonify({"error": "server_error"}), 500
    return jsonify(payload), 200
