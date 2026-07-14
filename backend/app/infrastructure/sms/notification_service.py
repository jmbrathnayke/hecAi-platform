"""Citizen SMS status-change notifications (Story 5.6, FR-6.3).

notify_status_change() is called by admin.py::post_case_action right after each of its five
action branches' own write_audit_log() call, in the SAME transaction. It never raises and never
affects the case's own already-committed status transition: a missing mobile number or a Twilio
failure is recorded as its own audit event, not an error (see CRITICAL #1/#7 in the story).
"""
from app.infrastructure.audit import write_audit_log
from app.infrastructure.sms.twilio_client import send_sms

# Hardcoded (CRITICAL #6, Story 5.6): no locale/language column exists anywhere in the schema, so
# there is no per-case language to look up. Sinhala matches the citizen portal's own default
# locale (AD-6) and the primary rural-Sinhala persona -- sms_templates already has ta/en rows
# seeded and ready the moment a per-case locale exists (see the story's Open Question OQ-B).
_LANGUAGE = "si"


def notify_status_change(cur, case_id, canonical_id, citizen_mobile_plain, new_status, admin_id,
                          amount_lkr=None):
    """citizen_mobile_plain is None for essentially every case today (only the SMS-fallback
    channel's extended grammar can ever populate it -- CRITICAL #1) -- that is the expected,
    normal case, not an error, and is logged as its own audit event so it's visible in the
    existing AuditTrail UI with zero frontend changes (CRITICAL #8)."""
    if citizen_mobile_plain is None:
        write_audit_log(cur, case_id, "sms_skipped_no_mobile", admin_id, {"status": new_status})
        return

    cur.execute(
        "SELECT template FROM sms_templates WHERE language = %s AND status = %s",
        (_LANGUAGE, new_status),
    )
    template = cur.fetchone()[0]

    rendered = template.replace("{ref}", canonical_id or "")
    if amount_lkr is not None:
        rendered = rendered.replace("{amount}", f"{amount_lkr:,.2f}")

    # Never put the mobile number (or anything decryptable to it) into audit metadata -- it's
    # already stored once on `cases`; duplicating it into an append-only log widens the exposure
    # surface for no benefit (CRITICAL #8).
    if send_sms(citizen_mobile_plain, rendered):
        write_audit_log(cur, case_id, "sms_sent", admin_id, {"status": new_status})
    else:
        write_audit_log(cur, case_id, "sms_failed", admin_id, {"status": new_status})
