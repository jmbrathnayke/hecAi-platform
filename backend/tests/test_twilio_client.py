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
