"""One entry point for citizen status notifications: Web Push, then email.

Every place that announces a status change to a citizen (admin.py, ds.py, officer_cases.py and
workflow_events.py) calls this one function, so no call site can gain or lose a channel that the
others do not.

THE CHANNELS.

    push   immediate, and carries no personal data at all: a subscription is an opaque browser
           endpoint, not a contact detail. Reaches only a device that has opened the app and
           granted permission, and only over HTTPS.
    email  slower, and needs an address the family chose to give at registration, but it
           persists, crosses devices and survives losing the phone.

Both degrade to the public status page (FR-6.1), which needs no address, no permission and no
login. That page is why a citizen never depends on either channel working.

NO PHONE NUMBER IS INVOLVED. Neither channel needs one and none is passed in: push resolves its
devices, and email its address, from the case's registered household.

NONE OF THESE RAISE. Each service catches its own failures and records the outcome as an audit
event. That is load-bearing: this runs inside the same transaction as the case's own status write,
so an exception escaping here would roll back the decision being announced.
"""
from app.infrastructure.email.email_service import notify_status_change_email
from app.infrastructure.push.push_service import notify_status_change_push


def notify_status_change_all(cur, case_id, canonical_id, new_status, actor_id, amount_lkr=None):
    """Announce a status change on both citizen channels, push first."""
    notify_status_change_push(
        cur, case_id, canonical_id, new_status, actor_id, amount_lkr=amount_lkr,
    )
    notify_status_change_email(
        cur, case_id, canonical_id, new_status, actor_id, amount_lkr=amount_lkr,
    )
