"""One entry point for citizen status notifications across all three channels.

admin.py::post_case_action has two branches that announce a status change (the approve path, which
carries an amount, and the shared path for every other action). Calling three services from each
would put six calls where two belong, and would make it easy for one branch to gain a channel the
other silently lacks.

THE CHAIN, and why there are three of them.

    push   immediate, no personal data at all, but only reaches a device that has opened the app
           and granted permission -- and only over HTTPS
    email  slower, needs an address the citizen chose to give at registration, but persists,
           crosses devices, and survives losing the phone
    SMS    reaches any handset with no app and no account -- and is currently undeliverable, for
           the regulatory reason in §7.2

Every channel degrades to the next, and all three degrade to the public status page (FR-6.1),
which needs no address, no permission and no login. That page is why a citizen is never dependent
on any of this working.

Ordered most-immediate first. The order is cosmetic -- all three run, none short-circuits -- but it
matches how the chain is described in the dissertation, and a reader following one into the other
should not have to reconcile two different orderings.

NONE OF THESE RAISE. Each service catches its own failures and records them as audit events. That
is load-bearing: this runs inside the same transaction as the case's own status write, so an
exception escaping here would roll back the decision being announced.
"""
from app.infrastructure.email.email_service import notify_status_change_email
from app.infrastructure.push.push_service import notify_status_change_push
from app.infrastructure.sms.notification_service import notify_status_change


def notify_status_change_all(cur, case_id, canonical_id, citizen_mobile_plain, new_status,
                             admin_id, amount_lkr=None):
    """Announce a status change on every configured channel.

    citizen_mobile_plain is passed through to the SMS service only; the email and push services
    resolve their own destinations from the case's household, because that is where a
    server-readable address can exist at all (see email_service's module docstring).
    """
    notify_status_change_push(
        cur, case_id, canonical_id, new_status, admin_id, amount_lkr=amount_lkr,
    )
    notify_status_change_email(
        cur, case_id, canonical_id, new_status, admin_id, amount_lkr=amount_lkr,
    )
    notify_status_change(
        cur, case_id, canonical_id, citizen_mobile_plain, new_status, admin_id,
        amount_lkr=amount_lkr,
    )
