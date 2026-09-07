"""Email and Web Push status notifications.

THE CONTRACT BOTH SERVICES MUST HOLD, and the reason most of these tests exist: they run inside
the same transaction as a case's already-applied status write. If either ever raises, the status
transition it was announcing is rolled back -- an admin approves a claim, the notification fails,
and the approval silently disappears. So "does not raise" is not defensive coding here, it is the
requirement, and every failure path below asserts an audit row rather than an exception.

The second theme is that a citizen's contact details must never reach the audit log. It is
append-only and rendered in the AuditTrail UI; the address is already stored once on `households`,
and copying it into a log widens the exposure surface for no operational gain.
"""
import json

import pytest

from app import create_app
from app.infrastructure.email.email_service import notify_status_change_email
from app.infrastructure.push.push_service import notify_status_change_push
from app.infrastructure.push.webpush_client import PushResult

EMAIL = "villager@example.lk"
REF = "HEC-2026-0042"


class FakeCursor:
    """Answers the specific statements the two services issue, and records audit writes.

    Deliberately keyed on distinctive fragments of each statement rather than on call order: a
    fake that returns rows positionally passes even when the service asks for the wrong thing.
    """

    def __init__(self, store):
        self.store = store
        self._one = None
        self._all = []

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        st = self.store

        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif "SELECT hash FROM audit_log" in s:
            self._one = (st["audit"][-1]["hash"],) if st["audit"] else None
        elif s.startswith("INSERT INTO audit_log"):
            st["audit"].append({"case_id": params[0], "event": params[1],
                                "actor_id": params[2], "metadata": params[3], "hash": params[5]})
            self._one = None
        elif "h.contact_email" in s:
            self._one = st.get("case_email_row", (EMAIL, "en"))
        elif "SELECT c.household_id, c.locale" in s:
            self._one = st.get("case_household_row", (7, "en"))
        elif "FROM push_subscriptions WHERE household_id" in s:
            self._all = st.get("subscriptions", [])
        elif s.startswith("DELETE FROM push_subscriptions"):
            st.setdefault("deleted", []).append(params[0])
            self._one = None
        elif "FROM email_templates" in s:
            self._one = st.get("email_template", ("HEC claim {ref} — {status}",
                                                  "Claim {ref}. Amount: LKR {amount}."))
        elif "FROM sms_templates" in s:
            self._one = st.get("sms_template", ("Claim {ref} approved. LKR {amount}.",))
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._all


@pytest.fixture
def store():
    return {"audit": []}


@pytest.fixture
def cur(store):
    return FakeCursor(store)


@pytest.fixture
def app():
    return create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SENDGRID_API_KEY": "SG.test", "SENDGRID_FROM_EMAIL": "noreply@example.lk",
        "VAPID_PUBLIC_KEY": "pub", "VAPID_PRIVATE_KEY": "priv",
        "VAPID_SUBJECT": "mailto:admin@example.lk",
    })


def events(store):
    return [entry["event"] for entry in store["audit"]]


# =========================================================== email
def test_email_is_sent_to_the_household_address(app, cur, store, monkeypatch):
    sent = {}
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email",
                        lambda to, subject, body: sent.update(to=to, subject=subject, body=body) or True)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1", amount_lkr=45000)

    assert sent["to"] == EMAIL
    assert REF in sent["subject"]
    assert "45,000.00" in sent["body"]
    assert events(store) == ["email_sent"]


def test_a_household_with_no_address_is_skipped_not_failed(app, cur, store, monkeypatch):
    """Registration makes the address optional, so this is the normal path for most families."""
    store["case_email_row"] = (None, "si")
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email",
                        lambda *a: pytest.fail("must not attempt a send with no address"))
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_skipped_no_address"]


def test_a_case_with_no_household_is_skipped(app, cur, store):
    """Cases predating migration 025 have no household to resolve an address from."""
    store["case_email_row"] = None
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_skipped_no_address"]


def test_a_missing_template_is_audited_not_raised(app, cur, store):
    store["email_template"] = None
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Some Future Status", "admin-1")
    assert events(store) == ["email_template_missing"]


def test_a_send_failure_is_recorded_as_failed(app, cur, store, monkeypatch):
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email", lambda *a: False)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_failed"]


def test_a_send_that_raises_does_not_escape(app, cur, store, monkeypatch):
    """If this propagated it would roll back the case's own status transition.

    sendgrid_client.send_email already swallows everything, so in production this cannot happen.
    The service defends anyway: the "never raises" guarantee is stated in email_service's docstring,
    and a guarantee enforced only in a collaborator breaks silently the day the collaborator is
    swapped for another transport.
    """
    def boom(*a):
        raise RuntimeError("SendGrid exploded")
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email", boom)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_failed"]


def test_the_address_never_reaches_the_audit_log(app, cur, store, monkeypatch):
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email", lambda *a: True)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert EMAIL not in json.dumps(store["audit"])


def test_a_non_approved_status_does_not_choke_on_the_amount_placeholder(app, cur, store, monkeypatch):
    """Plain replace, not str.format() -- an unsubstituted {amount} must not raise KeyError."""
    body = {}
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email",
                        lambda to, subject, b: body.update(b=b) or True)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Under Review", "admin-1")
    assert events(store) == ["email_sent"]
    assert "{amount}" in body["b"]


# =========================================================== push
def _subs(n):
    return [(i, f"https://push.example/{i}", f"p256dh-{i}", f"auth-{i}") for i in range(1, n + 1)]


def test_push_reaches_every_subscribed_device(app, cur, store, monkeypatch):
    store["subscriptions"] = _subs(3)
    calls = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: calls.append(e) or PushResult(delivered=True))
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1", amount_lkr=45000)

    assert len(calls) == 3
    assert events(store) == ["push_sent"]
    assert store["audit"][-1]["metadata"] and json.loads(store["audit"][-1]["metadata"])["delivered"] == 3


def test_a_dead_subscription_is_deleted_not_retried_forever(app, cur, store, monkeypatch):
    """404/410 means the browser discarded it. A table that never prunes slows every later send."""
    store["subscriptions"] = _subs(2)
    monkeypatch.setattr(
        "app.infrastructure.push.push_service.send_push",
        lambda e, p, a, payload: PushResult(delivered=False, gone=True) if e.endswith("/1")
        else PushResult(delivered=True),
    )
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")

    assert store["deleted"] == [1]
    assert events(store) == ["push_sent"]  # one device got it; that is success


def test_no_subscriptions_is_a_skip_not_a_failure(app, cur, store):
    store["subscriptions"] = []
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["push_skipped_no_subscription"]


def test_push_without_vapid_keys_is_skipped(cur, store):
    unconfigured = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                               "VAPID_PUBLIC_KEY": None, "VAPID_PRIVATE_KEY": None})
    with unconfigured.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["push_skipped_not_configured"]


def test_endpoints_and_keys_never_reach_the_audit_log(app, cur, store, monkeypatch):
    store["subscriptions"] = _subs(2)
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda *a: PushResult(delivered=True))
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")

    blob = json.dumps(store["audit"])
    assert "push.example" not in blob
    assert "p256dh-1" not in blob
    assert "auth-1" not in blob


def test_every_device_failing_is_recorded_as_failed(app, cur, store, monkeypatch):
    store["subscriptions"] = _subs(2)
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda *a: PushResult(delivered=False))
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["push_failed"]


def test_the_push_payload_carries_the_reference_for_the_status_page(app, cur, store, monkeypatch):
    """FR-6.1's page needs no login, so the notification stays actionable after a session expires."""
    store["subscriptions"] = _subs(1)
    captured = {}
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: captured.update(payload) or PushResult(delivered=True))
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")
    assert captured["ref"] == REF
    assert REF in captured["title"]
