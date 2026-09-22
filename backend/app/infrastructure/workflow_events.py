"""Submission-time workflow events, shared by every intake path that stores a case.

cases.py (online submit) and sync.py (the officer's offline batch) both create cases, and until now
each carried its own announcement logic -- which is how they drifted: the online path alerted staff,
the sync path alerted nobody, so an officer-assisted case collected offline reached the district
administrator only if they happened to open the dashboard.

WHO IS TOLD, by channel of intake (role- and event-appropriate, never "everyone"):

    citizen self-submission     citizen: "Submitted" confirmation (push, then email)
                                staff:   the field officers of the case's DS division -- the people
                                         who must now verify it. Nobody else yet.
    officer-assisted submission citizen: "Submitted" confirmation
                                staff:   the DWC administrator for the district -- the officer was
                                         present and classified the damage, so the case arrives
                                         already assessed and ready for administrative review.

NOTHING HERE RAISES. Every notifier records its own outcome in the audit log, and an exception would
roll back the citizen's submission, not merely the announcement of it.
"""
from app.infrastructure.audit import write_audit_log
from app.infrastructure.inference_log import insert_inference_log, parse_classification
from app.infrastructure.notifications import notify_status_change_all
from app.infrastructure.push.push_service import notify_staff_push


def record_officer_assisted_assessment(cur, case_id, offline_id, officer_id, classification,
                                       ai_severity):
    """An officer-assisted submission IS the officer's verification and AI assessment.

    Marks the case as reviewed and assessed by that officer, and -- when the draft carried its
    on-device classification -- records it in inference_log. A malformed classification never
    blocks the submission (the case is still genuine and officer-verified); the reason it was not
    recorded is audited instead.
    """
    cur.execute(
        """UPDATE cases
              SET assigned_officer_id = COALESCE(assigned_officer_id, %s),
                  officer_review_started_at = COALESCE(officer_review_started_at, now()),
                  officer_assessed_at = COALESCE(officer_assessed_at, now()),
                  officer_assessed_by = COALESCE(officer_assessed_by, %s)
            WHERE id = %s""",
        (officer_id, officer_id, case_id),
    )

    fields = None
    if isinstance(classification, dict):
        fields, error = parse_classification(classification)
        if error:
            write_audit_log(cur, case_id, "officer_classification_not_recorded", officer_id,
                            {"error": error})
            fields = None
        else:
            processing_ms = classification.get("ai_processing_time_ms")
            insert_inference_log(cur, case_id, fields, {
                "offline_id": offline_id,
                "officer_id": officer_id,
                "ai_severity": ai_severity,
                "ai_processing_time_ms": processing_ms
                if isinstance(processing_ms, (int, float)) and not isinstance(processing_ms, bool)
                else None,
                "source": "officer_assisted_submission",
            })

    metadata = {"channel": "officer_assisted_submission", "ai_severity": ai_severity,
                "classification_recorded": fields is not None}
    if fields is not None:
        metadata.update({
            "prediction": fields["prediction"],
            "confidence": fields["confidence"],
            "was_overridden": fields["was_overridden"],
            "override_category": fields["override_category"],
        })
    write_audit_log(cur, case_id, "officer_assessment_recorded", officer_id, metadata)


def announce_submission(cur, case_id, canonical_id, submitted_by_officer, district, ds_division,
                        actor_id):
    """Tell the citizen their claim was received and route the work to whoever acts next."""
    # Push and email both resolve their destination from the case's registered household.
    notify_status_change_all(cur, case_id, canonical_id, "Submitted", actor_id)
    if submitted_by_officer:
        notify_staff_push(cur, case_id, "assessment_complete", "admin", district, canonical_id,
                          actor_id)
    else:
        notify_staff_push(cur, case_id, "case_submitted", "officer", ds_division, canonical_id,
                          actor_id)
