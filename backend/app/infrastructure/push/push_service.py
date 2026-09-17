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
from urllib.parse import quote

from app.infrastructure.audit import write_audit_log
from app.infrastructure.push.webpush_client import push_configured, send_push

DEFAULT_LOCALE = "si"


def citizen_target_url(ref):
    """Where a citizen's notification opens: the public status page for this reference.

    Relative on purpose -- the service worker only follows same-origin paths, so a payload can
    never be used to send someone to another site. No login is needed there (FR-6.1)."""
    return "/status?ref=" + quote(ref or "", safe="")


# Where a STAFF notification opens: the protected work surface for the exact case, never the
# public status page. A field officer told "new report in your division" needs the case in front
# of them, not the citizen's view of it. Each route is behind the staff middleware, so a device
# whose session has expired is sent to that role's login first -- the reference carries no data.
_STAFF_TARGETS = {
    "officer": "/officer/cases/{ref}",
    "admin": "/admin/cases?ref={ref}",
    "ds_officer": "/ds/dashboard?ref={ref}",
}


def staff_target_url(role, ref):
    template = _STAFF_TARGETS.get(role)
    if not template or not ref:
        return None
    return template.replace("{ref}", quote(ref, safe=""))


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
        "url": citizen_target_url(ref),
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
    # Sent to the Divisional Secretariat when the DWC administrator approves. The DS office now
    # makes the FINAL compensation decision before releasing payment, so the alert asks for that
    # review rather than for a payment the amount of which has not yet been decided.
    "payment_pending": {
        "en": ("Final compensation review required",
               "{ref} was approved by DWC. Review the AI-assisted estimate and confirm the final amount."),
        "si": ("අවසන් වන්දි සමාලෝචනය අවශ්‍යයි",
               "{ref} වනජීවී දෙපාර්තමේන්තුව අනුමත කළේය. AI-සහාය ඇස්තමේන්තුව සමාලෝචනය කර අවසන් මුදල තහවුරු කරන්න."),
        "ta": ("இறுதி இழப்பீட்டு மறுஆய்வு தேவை",
               "{ref} DWC யால் அங்கீகரிக்கப்பட்டது. AI உதவி மதிப்பீட்டை மறுஆய்வு செய்து இறுதித் தொகையை உறுதிப்படுத்தவும்."),
    },
    # Sent to the DWC administrator for the district once a field officer has verified a case and
    # recorded the on-device AI assessment -- the point at which administrative review can begin.
    "assessment_complete": {
        "en": ("Officer assessment ready for review",
               "{ref} — a field officer has verified this case in {scope}. Administrative review is required."),
        "si": ("නිලධාරී තක්සේරුව සමාලෝචනයට සූදානම්",
               "{ref} — {scope} හි ක්ෂේත්‍ර නිලධාරියෙකු මෙම සිද්ධිය තහවුරු කර ඇත. පරිපාලන සමාලෝචනය අවශ්‍යයි."),
        "ta": ("அலுவலர் மதிப்பீடு மறுஆய்வுக்குத் தயார்",
               "{ref} — {scope} பகுதியில் கள அலுவலர் ஒருவர் இந்த வழக்கைச் சரிபார்த்துள்ளார். நிர்வாக மறுஆய்வு தேவை."),
    },
    # Sent to the DWC administrator when the DS office records the final compensation decision.
    "final_decision_recorded": {
        "en": ("DS final decision recorded",
               "{ref} — the Divisional Secretariat has confirmed the final compensation amount."),
        "si": ("ප්‍රාදේශීය ලේකම් අවසන් තීරණය සටහන් විය",
               "{ref} — අවසන් වන්දි මුදල ප්‍රාදේශීය ලේකම් කාර්යාලය විසින් තහවුරු කර ඇත."),
        "ta": ("பிரதேச செயலக இறுதி முடிவு பதிவு செய்யப்பட்டது",
               "{ref} — இறுதி இழப்பீட்டுத் தொகையை பிரதேச செயலகம் உறுதிப்படுத்தியுள்ளது."),
    },
    # Sent to the responsible DWC staff once payment has been authorised by the DS office.
    "payment_processed": {
        "en": ("Payment processed",
               "{ref} — payment has been authorised by the Divisional Secretariat."),
        "si": ("ගෙවීම සිදු කරන ලදී",
               "{ref} — ගෙවීම ප්‍රාදේශීය ලේකම් කාර්යාලය විසින් අනුමත කර ඇත."),
        "ta": ("கட்டணம் செயலாக்கப்பட்டது",
               "{ref} — கட்டணம் பிரதேச செயலகத்தால் அங்கீகரிக்கப்பட்டது."),
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
        # The routing key is recorded on every outcome, delivered or not, so "which office was this
        # alert meant for" is answerable from the audit trail alone. Public geography only.
        write_audit_log(cur, case_id, "staff_push_skipped_not_configured", actor_id,
                        {"alert": alert, "role": role, "scope": scope_value})
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
                        {"alert": alert, "role": role, "scope": scope_value})
        return

    if not subscriptions:
        write_audit_log(cur, case_id, "staff_push_skipped_no_subscription", actor_id,
                        {"alert": alert, "role": role, "scope": scope_value})
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
            # The protected case surface for this role, so a tap lands on the exact case.
            "url": staff_target_url(role, ref),
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
