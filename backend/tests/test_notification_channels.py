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
from app.infrastructure.email.sendgrid_client import email_configured
from app.infrastructure.push.push_service import (
    notify_staff_push,
    notify_status_change_push,
)
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
        # Every statement is recorded so a test can assert on the QUERY, not merely on the rows
        # this fake chose to hand back. Without that, a test of "only this division is notified"
        # passes even when the WHERE clause stops filtering, because the filtering it observes is
        # the fake's own Python.
        st.setdefault("sql", []).append((s, params))

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
        elif "WHERE staff_role" in s:
            # Applies the SAME predicate the real query does (role match AND scope membership)
            # rather than returning a canned list. A fake that ignores the WHERE clause would let
            # every isolation test below pass against a service that notified everyone.
            role, scope = params
            self._all = [
                (sub["id"], sub["endpoint"], sub["p256dh"], sub["auth"], sub.get("locale", "si"))
                for sub in st.get("staff_subscriptions", [])
                if sub["role"] == role and scope in sub["scope"]
            ]
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


def test_email_without_a_sendgrid_key_is_skipped_not_failed(cur, store, monkeypatch):
    """An unprovisioned deployment must not look like a broken one in the audit log.

    This is the state the platform is actually in (§7.3): email is implemented and configurable,
    and no SendGrid key has been provisioned. Before this distinction existed, every notification
    on that deployment wrote "email_failed", which reads as a provider rejecting mail rather than
    as a deployment that was never asked to send any. Mirrors push_skipped_not_configured, so both
    channels report an unprovisioned transport the same way.
    """
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email",
                        lambda *a: pytest.fail("must not attempt a send with no credentials"))
    unconfigured = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                               "SENDGRID_API_KEY": None, "SENDGRID_FROM_EMAIL": None})
    with unconfigured.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1", amount_lkr=45000)
    assert events(store) == ["email_skipped_not_configured"]


def test_a_key_with_no_sender_address_is_still_unconfigured(cur, store, monkeypatch):
    """SendGrid needs BOTH halves; a key alone sends nothing.

    Checked separately because a half-filled .env is the realistic way this happens -- someone
    pastes the key and forgets the verified sender -- and "half configured" must degrade to the
    same honest skip rather than to a delivery failure.
    """
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email",
                        lambda *a: pytest.fail("must not attempt a send without a sender address"))
    half = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                       "SENDGRID_API_KEY": "SG.test", "SENDGRID_FROM_EMAIL": None})
    with half.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_skipped_not_configured"]


def test_no_address_is_reported_even_when_email_is_unconfigured(cur, store):
    """The ordering property, and the reason the check sits where it does.

    A family that gave no address reports no_address whether or not mail is provisioned. If the
    configuration check ran first it would mask that, and the recorded reason for this case would
    silently CHANGE from not_configured to no_address the day a SendGrid key is finally added --
    rewriting the apparent history of a case nobody touched.
    """
    store["case_email_row"] = (None, "si")
    unconfigured = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                               "SENDGRID_API_KEY": None, "SENDGRID_FROM_EMAIL": None})
    with unconfigured.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_skipped_no_address"]


def test_a_configured_deployment_that_fails_still_reports_failed(app, cur, store, monkeypatch):
    """The other side of the distinction: with credentials present, a rejection is a failure.

    Guards against the fix collapsing every unsent email into a skip, which would hide real
    delivery problems -- an unverified sender or a suppressed address -- behind a benign event.
    """
    monkeypatch.setattr("app.infrastructure.email.email_service.send_email", lambda *a: False)
    with app.app_context():
        notify_status_change_email(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["email_failed"]


def test_email_configured_requires_both_halves():
    """The predicate itself, including the no-application-context case."""
    both = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                       "SENDGRID_API_KEY": "SG.test", "SENDGRID_FROM_EMAIL": "a@b.lk"})
    with both.app_context():
        assert email_configured() is True

    for key, sender in ((None, "a@b.lk"), ("SG.test", None), (None, None), ("", "a@b.lk")):
        partial = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                              "SENDGRID_API_KEY": key, "SENDGRID_FROM_EMAIL": sender})
        with partial.app_context():
            assert email_configured() is False, f"{key!r}/{sender!r} must not count as configured"

    # Outside an application context current_app raises. The notification path must survive that.
    assert email_configured() is False


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


# =========================================================== staff-directed push (FR-6.4)
def _staff(sub_id, role, scope, locale="en"):
    return {"id": sub_id, "role": role, "scope": scope, "locale": locale,
            "endpoint": "https://push.example/%s" % sub_id,
            "p256dh": "p256dh-%s" % sub_id, "auth": "auth-%s" % sub_id}


def test_the_ds_officer_for_the_division_is_told_a_payment_is_waiting(app, cur, store, monkeypatch):
    """The gap this feature closed: approval is when the DS office acquires work.

    Before FR-6.4 the DS officer learned a payment was waiting only by opening the dashboard and
    looking -- a poll, in the one place where a delay is a family waiting on money.
    """
    store["staff_subscriptions"] = [_staff(1, "ds_officer", ["Galnewa"])]
    sent = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: sent.append(payload) or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")

    assert events(store) == ["staff_push_sent"]
    assert REF in sent[0]["body"]
    assert sent[0]["title"] == "Payment authorisation required"


def test_a_staff_device_in_another_division_is_not_notified(app, cur, store, monkeypatch):
    """The isolation property, and the whole reason the scope is a routing key.

    A DS officer must not learn the reference of a case belonging to a division they have no
    authority over -- the same boundary ds.py enforces by returning 404 rather than 403 for a case
    outside the officer's division.
    """
    store["staff_subscriptions"] = [
        _staff(1, "ds_officer", ["Galnewa"]),
        _staff(2, "ds_officer", ["Thalawa"]),
    ]
    sent = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: sent.append(e) or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")

    assert sent == ["https://push.example/1"], "only the Galnewa device may be reached"
    assert store["audit"][-1]["metadata"] is not None


def test_a_different_role_in_the_same_division_is_not_notified(app, cur, store, monkeypatch):
    """Role and scope are ANDed. A field officer covering Galnewa is not the DS office."""
    store["staff_subscriptions"] = [
        _staff(1, "officer", ["Galnewa"]),
        _staff(2, "ds_officer", ["Galnewa"]),
    ]
    sent = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: sent.append(e) or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")

    assert sent == ["https://push.example/2"]


def test_an_officer_covering_several_divisions_is_reached_by_any_of_them(app, cur, store,
                                                                        monkeypatch):
    """assigned_divisions is a list, which is why staff_scope is an array (migration 032)."""
    store["staff_subscriptions"] = [_staff(1, "officer", ["Galnewa", "Thalawa", "Ipalogama"])]
    sent = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: sent.append(e) or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "case_submitted", "officer", "Thalawa", REF, "citizen-1")

    assert sent == ["https://push.example/1"]
    assert events(store) == ["staff_push_sent"]


def test_nobody_subscribed_is_a_skip_not_a_failure(app, cur, store):
    """Staff opt in per browser. An alert nobody asked for is the normal state, not an error."""
    store["staff_subscriptions"] = []
    with app.app_context():
        notify_staff_push(cur, 1, "case_submitted", "officer", "Galnewa", REF, "citizen-1")
    assert events(store) == ["staff_push_skipped_no_subscription"]


def test_a_case_with_no_division_is_recorded_rather_than_dropped(app, cur, store):
    """An unroutable case means one nobody is responsible for -- worth being able to find later."""
    with app.app_context():
        notify_staff_push(cur, 1, "case_submitted", "officer", None, REF, "citizen-1")
    assert events(store) == ["staff_push_skipped_no_scope"]


def test_staff_push_without_vapid_keys_is_skipped(cur, store):
    unconfigured = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                               "VAPID_PUBLIC_KEY": None, "VAPID_PRIVATE_KEY": None})
    with unconfigured.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")
    assert events(store) == ["staff_push_skipped_not_configured"]


def test_each_device_gets_its_own_language(app, cur, store, monkeypatch):
    """Two officers scoped to one division may read the app in different languages."""
    store["staff_subscriptions"] = [
        _staff(1, "ds_officer", ["Galnewa"], locale="si"),
        _staff(2, "ds_officer", ["Galnewa"], locale="en"),
    ]
    titles = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: titles.append(payload["title"])
                        or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")

    assert len(set(titles)) == 2, "each device must be addressed in its own language"
    assert "Payment authorisation required" in titles


def test_an_unknown_locale_falls_back_to_english_rather_than_raising(app, cur, store, monkeypatch):
    store["staff_subscriptions"] = [_staff(1, "ds_officer", ["Galnewa"], locale="fr")]
    titles = []
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: titles.append(payload["title"])
                        or PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")
    assert titles == ["Payment authorisation required"]


def test_a_dead_staff_subscription_is_pruned(app, cur, store, monkeypatch):
    store["staff_subscriptions"] = [_staff(1, "ds_officer", ["Galnewa"])]
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: PushResult(delivered=False, gone=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")
    assert store["deleted"] == [1]
    assert events(store) == ["staff_push_failed"]


def test_staff_endpoints_and_keys_never_reach_the_audit_log(app, cur, store, monkeypatch):
    """Same rule the citizen channels hold to: the log is append-only and widely read."""
    store["staff_subscriptions"] = [_staff(1, "ds_officer", ["Galnewa"])]
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")
    blob = json.dumps(store["audit"])
    assert "push.example" not in blob
    assert "p256dh-1" not in blob and "auth-1" not in blob


def test_a_staff_send_that_raises_does_not_escape(app, cur, store, monkeypatch):
    """Load-bearing at the cases.py call site: an escape there rolls back the citizen's SUBMISSION,
    losing the report itself rather than merely its announcement."""
    store["staff_subscriptions"] = [_staff(1, "officer", ["Galnewa"])]

    def boom(*a):
        raise RuntimeError("push transport exploded")
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push", boom)
    with app.app_context():
        notify_staff_push(cur, 1, "case_submitted", "officer", "Galnewa", REF, "citizen-1")
    assert events(store) == ["staff_push_failed"]


def test_the_staff_lookup_filters_in_SQL_not_in_python(app, cur, store, monkeypatch):
    """The routing predicate must be in the statement the database runs.

    Asserted directly because every other isolation test here observes rows the fake filtered, so
    they would all still pass if the WHERE clause stopped narrowing and the service leaned on the
    double's behaviour. Against a real database that mutation notifies every officer in the
    country about a case in one division.
    """
    store["staff_subscriptions"] = [_staff(1, "ds_officer", ["Galnewa"])]
    monkeypatch.setattr("app.infrastructure.push.push_service.send_push",
                        lambda e, p, a, payload: PushResult(delivered=True))
    with app.app_context():
        notify_staff_push(cur, 1, "payment_pending", "ds_officer", "Galnewa", REF, "admin-1")

    lookups = [(s, p) for s, p in store["sql"]
               if "FROM push_subscriptions" in s and "staff_role" in s]
    assert lookups, "the service must look subscriptions up by staff role"
    sql, params = lookups[0]
    assert "staff_role = %s" in sql, "role must be part of the predicate"
    assert "= ANY(staff_scope)" in sql, "scope membership must be part of the predicate"
    assert params == ("ds_officer", "Galnewa")


def test_a_citizen_push_that_raises_does_not_escape(app, cur, store, monkeypatch):
    """The citizen half of the never-raises promise, which was stated but never tested.

    Same consequence as the staff path: this runs inside the transaction carrying the case's own
    status write, so an escape rolls back the decision being announced.
    """
    store["subscriptions"] = _subs(1)

    def boom(*a):
        raise RuntimeError("push transport exploded")

    monkeypatch.setattr("app.infrastructure.push.push_service.send_push", boom)
    with app.app_context():
        notify_status_change_push(cur, 1, REF, "Approved", "admin-1")
    assert events(store) == ["push_failed"]
