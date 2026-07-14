"""Tests for infrastructure/sms/twilio_client.py::send_sms (Story 5.6).

send_sms() must never raise (a Twilio outage must never turn an already-committed case
action into an HTTP 500 for the caller) but must now return True/False so callers -- notably
notification_service.notify_status_change() -- can tell success from failure and log the
right audit event. No real Twilio: get_twilio_client() is monkeypatched to a fake client whose
messages.create() either succeeds or raises TwilioRestException.
"""
from twilio.base.exceptions import TwilioRestException

from app import create_app
from app.infrastructure.sms import twilio_client


class _FakeMessages:
    def __init__(self, should_fail):
        self.should_fail = should_fail
        self.calls = []

    def create(self, to, from_, body):
        self.calls.append({"to": to, "from_": from_, "body": body})
        if self.should_fail:
            raise TwilioRestException(status=500, uri="/Messages", msg="boom")


class _FakeClient:
    def __init__(self, should_fail):
        self.messages = _FakeMessages(should_fail)


def _app():
    return create_app(
        {
            "TESTING": True,
            "DATABASE_URL": "postgresql://fake",
            "TWILIO_ACCOUNT_SID": "ACfake",
            "TWILIO_AUTH_TOKEN": "fake-token",
            "TWILIO_FROM_NUMBER": "+94770000000",
        }
    )


def test_send_sms_returns_true_on_success(monkeypatch):
    app = _app()
    fake_client = _FakeClient(should_fail=False)
    monkeypatch.setattr(twilio_client, "get_twilio_client", lambda: fake_client)
    with app.app_context():
        result = twilio_client.send_sms("+94771234567", "hello")
    assert result is True
    assert fake_client.messages.calls == [
        {"to": "+94771234567", "from_": "+94770000000", "body": "hello"}
    ]


def test_send_sms_returns_false_on_twilio_failure_and_does_not_raise(monkeypatch):
    app = _app()
    fake_client = _FakeClient(should_fail=True)
    monkeypatch.setattr(twilio_client, "get_twilio_client", lambda: fake_client)
    with app.app_context():
        result = twilio_client.send_sms("+94771234567", "hello")
    assert result is False


def test_send_sms_returns_false_and_does_not_raise_on_a_non_twilio_exception(monkeypatch):
    # Code review (Story 5.6): the original except clause only caught TwilioRestException, so a
    # misconfigured/missing credential raising inside get_twilio_client() itself (e.g. KeyError)
    # would have escaped send_sms entirely, propagating up through notify_status_change() and
    # rolling back the case's own already-applied status transition.
    app = _app()

    def _raise_key_error():
        raise KeyError("TWILIO_ACCOUNT_SID")

    monkeypatch.setattr(twilio_client, "get_twilio_client", _raise_key_error)
    with app.app_context():
        result = twilio_client.send_sms("+94771234567", "hello")
    assert result is False
