"""Citizen Web Push status-change notifications.

Same contract as sms/notification_service.py and email/email_service.py: called from
admin.py::post_case_action inside the SAME transaction as the case's own status write, it never
raises, and every outcome is recorded as its own audit event.

WHERE THE WORDING COMES FROM, and why there is no push_templates table. A push notification has a
title and a body, and the two have different length budgets: the title must be short enough for a
notification shade, and the body shorter still. Both strings already exist, already translated, and
already reviewed:

    title  <- email_templates.subject   (migration 030) -- short, carries {ref}
    body   <- sms_templates.template    (migration 019) -- written for a 160-character budget

Reusing them means the SMS, the email, the push and the public status page cannot drift apart in
terminology, which is the same reason migration 030 copied its core sentences from 019 verbatim. A
third table would be a third place for the wording to diverge.

ONE CASE, MANY DEVICES. A household may have several subscribed devices -- the registrant's phone,
a son's phone. All are notified. Partial success counts as success: one device receiving the news
is the outcome that matters, and a dead endpoint on another device is churn, not a failure.
"""
from app.infrastructure.audit import write_audit_log
from app.infrastructure.push.webpush_client import push_configured, send_push

DEFAULT_LOCALE = "si"


def notify_status_change_push(cur, case_id, canonical_id, new_status, admin_id, amount_lkr=None):
    """Push a status change to every device subscribed against the case's household."""
    if not push_configured():
        write_audit_log(cur, case_id, "push_skipped_not_configured", admin_id,
                        {"status": new_status})
        return

    try:
        cur.execute(
            "SELECT c.household_id, c.locale FROM cases c WHERE c.id = %s",
            (case_id,),
        )
        row = cur.fetchone()
    except Exception:
        write_audit_log(cur, case_id, "push_skipped_lookup_failed", admin_id,
                        {"status": new_status})
        return

    if row is None or row[0] is None:
        # Cases predating migration 025 carry no household, so there is nothing to route to.
        write_audit_log(cur, case_id, "push_skipped_no_subscription", admin_id,
                        {"status": new_status})
        return

    household_id, locale = row[0], row[1] or DEFAULT_LOCALE

    cur.execute(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE household_id = %s",
        (household_id,),
    )
    subscriptions = cur.fetchall()
    if not subscriptions:
        write_audit_log(cur, case_id, "push_skipped_no_subscription", admin_id,
                        {"status": new_status})
        return

    cur.execute(
        "SELECT subject FROM email_templates WHERE language = %s AND status = %s",
        (locale, new_status),
    )
    title_row = cur.fetchone()
    cur.execute(
        "SELECT template FROM sms_templates WHERE language = %s AND status = %s",
        (locale, new_status),
    )
    body_row = cur.fetchone()

    if title_row is None or body_row is None:
        write_audit_log(cur, case_id, "push_template_missing", admin_id, {"status": new_status})
        return

    ref = canonical_id or ""
    title = title_row[0].replace("{ref}", ref)
    body = body_row[0].replace("{ref}", ref)
    if amount_lkr is not None:
        body = body.replace("{amount}", f"{amount_lkr:,.2f}")

    payload = {
        "title": title,
        "body": body,
        # The service worker opens the public status page for this reference. It needs no login
        # (FR-6.1), so the notification is actionable even if the session has expired.
        "ref": ref,
        "status": new_status,
    }

    delivered = 0
    expired = []
    for subscription_id, endpoint, p256dh, auth in subscriptions:
        # webpush_client.send_push already swallows everything. Guarded here too for the same
        # reason email_service guards its send: this module promises never to raise, and one dead
        # device must not stop the remaining devices from being tried.
        try:
            result = send_push(endpoint, p256dh, auth, payload)
        except Exception:
            continue
        if result.delivered:
            delivered += 1
        elif result.gone:
            expired.append(subscription_id)

    # Prune dead endpoints in the same transaction. Leaving them makes every later send slower for
    # no chance of delivery; the browser issues a fresh subscription if the user comes back.
    for subscription_id in expired:
        cur.execute("DELETE FROM push_subscriptions WHERE id = %s", (subscription_id,))

    # Device counts only -- never an endpoint or a key. The audit log is append-only and widely
    # read; the same rule keeps the mobile number and the email address out of it.
    metadata = {"status": new_status, "devices": len(subscriptions), "delivered": delivered}
    if expired:
        metadata["expired"] = len(expired)

    write_audit_log(cur, case_id, "push_sent" if delivered else "push_failed", admin_id, metadata)
