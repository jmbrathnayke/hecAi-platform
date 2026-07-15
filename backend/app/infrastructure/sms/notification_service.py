"""Citizen SMS status-change notifications (Story 5.6, FR-6.3).

notify_status_change() is called by admin.py::post_case_action right after each of its five
action branches' own write_audit_log() call, in the SAME transaction. It never raises and never
affects the case's own already-committed status transition: a missing mobile number or a Twilio
failure is recorded as its own audit event, not an error (see CRITICAL #1/#7 in the story).
"""
from app.infrastructure.audit import write_audit_log
from app.infrastructure.sms.twilio_client import send_sms

# Look up case locale from the cases table (Story 5.6, FR-6.3, OQ-B resolved).
# Fall back to 'si' (Sinhala) if not found.


def notify_status_change(cur, case_id, canonical_id, citizen_mobile_plain, new_status, admin_id,
                          amount_lkr=None):
    """citizen_mobile_plain is None for essentially every case today (only the SMS-fallback
    channel's extended grammar can ever populate it -- CRITICAL #1) -- that is the expected,
    normal case, not an error, and is logged as its own audit event so it's visible in the
    existing AuditTrail UI with zero frontend changes (CRITICAL #8)."""
    if citizen_mobile_plain is None:
        write_audit_log(cur, case_id, "sms_skipped_no_mobile", admin_id, {"status": new_status})
        return

    # Fetch locale from cases table
    try:
        cur.execute("SELECT locale FROM cases WHERE id = %s", (case_id,))
        row_locale = cur.fetchone()
        locale = row_locale[0] if row_locale else "si"
    except Exception:
        locale = "si"

    cur.execute(
        "SELECT template FROM sms_templates WHERE language = %s AND status = %s",
        (locale, new_status),
    )
    row = cur.fetchone()
    if row is None:
        # No seeded (language, status) row -- e.g. migration 019 not applied, or a future status
        # value with no template yet (code review, Story 5.6). Must not raise: this call happens
        # inside the same DB transaction as the case's own status write (AC1), and an unhandled
        # exception here would roll back that already-applied transition, contradicting AC5.
        write_audit_log(cur, case_id, "sms_template_missing", admin_id, {"status": new_status})
        return
    template = row[0]

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
