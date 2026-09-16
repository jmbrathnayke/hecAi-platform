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


# =============================================================== staff-directed alerting (FR-6.4)
#
# The citizen path above answers "this case changed, tell the family". This one answers the
# opposite question -- "work has arrived, tell whoever has to act on it" -- and it is the direction
# the platform was missing entirely: until migration 032 no member of staff was notified of
# anything, and a DS officer learned that a payment was waiting only by opening the dashboard and
# looking.
#
# WHY THE WORDING IS IN CODE AND NOT IN A TEMPLATE TABLE, which is the opposite of the decision
# made for the citizen channels. The citizen wording lives in sms_templates and email_templates
# because the SAME sentence has to appear in an SMS, an email, a push notification and the public
# status page, and four copies of it would drift. A staff alert has no second channel to agree
# with: it exists only as a push notification. A table would add a migration, a seeding step and a
# "template missing" failure mode in exchange for keeping one copy of a string consistent with
# nothing. If a staff alert ever gains an email counterpart, this becomes a table.
#
# Keyed by locale, which comes from the subscription row -- the language the staff member chose in
# the app, not the language of the case.
STAFF_ALERTS = {
    "case_submitted": {
        "en": ("New incident report",
               "{ref} — a new report has arrived in {scope}."),
        "si": ("නව සිද්ධි වාර්තාවක්",
               "{ref} — {scope} කොට්ඨාසයෙන් නව වාර්තාවක් ලැබී ඇත."),
        "ta": ("புதிய சம்பவ அறிக்கை",
               "{ref} — {scope} பகுதியிலிருந்து புதிய அறிக்கை வந்துள்ளது."),
    },
    "payment_pending": {
        "en": ("Payment authorisation required",
               "{ref} has been approved. Payment is waiting for your authorisation."),
        "si": ("ගෙවීම අනුමත කරන්න",
               "{ref} අනුමත විය. ගෙවීම ඔබේ අනුමතිය බලාපොරොත්තුවෙන් ඇත."),
        "ta": ("கட்டண அனுமதி தேவை",
               "{ref} அனுமதிக்கப்பட்டது. கட்டணம் உங்கள் அனுமதிக்காக காத்திருக்கிறது."),
    },
}


def notify_staff_push(cur, case_id, alert, role, scope_value, canonical_id, actor_id):
    """Alert every device subscribed by staff of `role` whose scope covers `scope_value`.

    Same never-raises contract as the citizen path, and for a stronger reason: one call site is
    cases.py::submit_case, where an exception would roll back a citizen's SUBMISSION -- losing the
    report itself, not merely the announcement of it.

    Silent when nobody is subscribed, which is the normal state: staff opt in per browser, and an
    alert nobody has asked for is not a failure. Every outcome is still audited, so "the DS office
    was never told" is answerable from the record rather than inferred.
    """
    if alert not in STAFF_ALERTS:  # pragma: no cover - guards a caller typo, not a runtime state
        return
    if not push_configured():
        write_audit_log(cur, case_id, "staff_push_skipped_not_configured", actor_id,
                        {"alert": alert, "role": role})
        return
    if not scope_value:
        # An unscoped case cannot be routed to anyone. Recorded rather than dropped: it means a
        # case exists that no officer is responsible for, which is worth being able to find later.
        write_audit_log(cur, case_id, "staff_push_skipped_no_scope", actor_id,
                        {"alert": alert, "role": role})
        return

    try:
        cur.execute(
            """SELECT id, endpoint, p256dh, auth, locale
                 FROM push_subscriptions
                WHERE staff_role = %s AND %s = ANY(staff_scope)""",
            (role, scope_value),
        )
        subscriptions = cur.fetchall()
    except Exception:
        # Migration 032 not applied yet: the staff_* columns do not exist and this statement raises.
        # Must not take the caller down with it -- see the docstring.
        write_audit_log(cur, case_id, "staff_push_skipped_lookup_failed", actor_id,
                        {"alert": alert, "role": role})
        return

    if not subscriptions:
        write_audit_log(cur, case_id, "staff_push_skipped_no_subscription", actor_id,
                        {"alert": alert, "role": role})
        return

    ref = canonical_id or ""
    delivered = 0
    expired = []
    for subscription_id, endpoint, p256dh, auth, locale in subscriptions:
        # Per-subscription locale: two officers scoped to the same division may read the app in
        # different languages, so the wording is chosen per device rather than per case.
        strings = STAFF_ALERTS[alert]
        title, body = strings.get(locale or DEFAULT_LOCALE, strings["en"])
        payload = {
            "title": title.replace("{ref}", ref).replace("{scope}", scope_value),
            "body": body.replace("{ref}", ref).replace("{scope}", scope_value),
            "ref": ref,
            "status": alert,
        }
        try:
            result = send_push(endpoint, p256dh, auth, payload)
        except Exception:
            continue
        if result.delivered:
            delivered += 1
        elif result.gone:
            expired.append(subscription_id)

    for subscription_id in expired:
        cur.execute("DELETE FROM push_subscriptions WHERE id = %s", (subscription_id,))

    # Counts and the routing key only. The scope is a district or division name -- public
    # geography, already on the case row -- and no endpoint, key or account id is recorded.
    metadata = {"alert": alert, "role": role, "scope": scope_value,
                "devices": len(subscriptions), "delivered": delivered}
    if expired:
        metadata["expired"] = len(expired)

    write_audit_log(cur, case_id,
                    "staff_push_sent" if delivered else "staff_push_failed", actor_id, metadata)
