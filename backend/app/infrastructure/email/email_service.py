"""Citizen email status-change notifications.

The email counterpart of sms/notification_service.py, and it holds to the same contract: called
from admin.py::post_case_action inside the SAME transaction as the case's own status write, it
never raises, and every outcome -- including "there was nobody to write to" -- is recorded as its
own audit event rather than swallowed or escalated.

WHERE THE ADDRESS COMES FROM, and why it is not a column on `cases`. Migration 020 added
cases.citizen_mobile_plain and its own comment records what happened: it "stays NULL for every case
from those channels", because the app and officer-assisted paths AES-GCM encrypt citizen contact
details client-side with a non-extractable key the server can never decrypt (NFR-3.1). A plaintext
email column on `cases` would inherit exactly that fate.

Registration is the one path that already transmits server-readable citizen data, under the
deliberate NFR-3.1 exception documented in Addendum A8. So the address lives on `households`, and
since migration 025 -- with the FR-10.3 submit gate making household_id mandatory -- every new case
resolves to one:

    cases.household_id -> households.contact_email
"""
from app.infrastructure.audit import write_audit_log
from app.infrastructure.email.sendgrid_client import email_configured, send_email

DEFAULT_LOCALE = "si"


def notify_status_change_email(cur, case_id, canonical_id, new_status, admin_id, amount_lkr=None):
    """Email the registered household about a status change.

    Unlike notify_status_change(), the address is resolved here rather than passed in: the caller
    holds a case row, and the address hangs off the household behind it. Doing the lookup here
    keeps admin.py's five action branches unchanged apart from one added call.

    Every early return writes an audit row. A silent skip would be indistinguishable from a bug,
    and the AuditTrail UI already renders these events with no frontend change.
    """
    try:
        cur.execute(
            "SELECT h.contact_email, c.locale"
            "  FROM cases c LEFT JOIN households h ON h.id = c.household_id"
            " WHERE c.id = %s",
            (case_id,),
        )
        row = cur.fetchone()
    except Exception:
        # A malformed query or a missing column (migration 029 not applied) must not roll back the
        # status transition this notification is merely announcing.
        write_audit_log(cur, case_id, "email_skipped_lookup_failed", admin_id,
                        {"status": new_status})
        return

    if row is None:
        write_audit_log(cur, case_id, "email_skipped_no_address", admin_id, {"status": new_status})
        return

    contact_email, locale = row[0], row[1] or DEFAULT_LOCALE

    # Expected and normal: registration makes the address optional, and cases predating migration
    # 025 have no household at all. Not an error.
    if not contact_email:
        write_audit_log(cur, case_id, "email_skipped_no_address", admin_id, {"status": new_status})
        return

    cur.execute(
        "SELECT subject, body FROM email_templates WHERE language = %s AND status = %s",
        (locale, new_status),
    )
    template = cur.fetchone()
    if template is None:
        # Same failure mode migration 019 anticipated for SMS: an unseeded (language, status) pair,
        # or a future status with no template yet. Must not raise -- see the module docstring.
        write_audit_log(cur, case_id, "email_template_missing", admin_id, {"status": new_status})
        return

    subject, body = template[0], template[1]

    # Plain replace, not str.format(): a non-Approved template contains no {amount}, and format()
    # would raise KeyError on the braces it does contain. Same rule as notification_service.py.
    ref = canonical_id or ""
    subject = subject.replace("{ref}", ref)
    body = body.replace("{ref}", ref)
    if amount_lkr is not None:
        body = body.replace("{amount}", f"{amount_lkr:,.2f}")

    # Not provisioned is a DEPLOYMENT state, not a delivery failure, and the audit log is the only
    # place that difference is visible to anyone reading the case afterwards. Recording both as
    # "email_failed" made a deployment that had simply never been given a SendGrid key look exactly
    # like one whose mail was being rejected by the provider -- two problems with different owners
    # and different fixes.
    #
    # CHECKED HERE, after the address and the template have resolved, rather than at the top of the
    # function. The earlier skips are more specific and more actionable, so they must keep winning:
    # a case whose family gave no address reports no_address whether or not mail is provisioned,
    # and does not silently change its recorded reason the day a key is finally added.
    if not email_configured():
        write_audit_log(cur, case_id, "email_skipped_not_configured", admin_id,
                        {"status": new_status})
        return

    # The address never enters audit metadata. It is already stored once on `households`;
    # duplicating it into an append-only, widely-read log enlarges the exposure surface for no
    # operational benefit. Same rule notification_service.py applies to the mobile number.
    # sendgrid_client.send_email already swallows everything it can raise. The guard is here as
    # well because this module's docstring is where the "never raises" promise is made, and a
    # promise enforced only inside a collaborator breaks silently the day the transport changes.
    try:
        delivered = send_email(contact_email, subject, body)
    except Exception:
        delivered = False

    write_audit_log(cur, case_id, "email_sent" if delivered else "email_failed", admin_id,
                    {"status": new_status})
