"""The outbound mail transport (app/infrastructure/email/smtp_client.py).

THE CONTRACT THIS PROTECTS. send_email() runs inside the same transaction as a case's already-applied
status write, so it must never raise: an exception here would roll back the decision the email was
merely announcing. Everything below is about that promise and about what reaches the log.

Replaced a SendGrid-specific client after SendGrid withdrew its free tier. The point of SMTP is that
the provider is a deployment decision, so nothing here names one.
"""
import logging
import smtplib

import pytest

from app import create_app
from app.infrastructure.email import smtp_client
from app.infrastructure.email.smtp_client import _mask, email_configured, send_email

FULL = {
    "SMTP_HOST": "smtp.example.lk",
    "SMTP_PORT": "587",
    "SMTP_USERNAME": "user",
    "SMTP_PASSWORD": "pw",
    "SMTP_FROM_EMAIL": "noreply@example.lk",
}


class FakeSMTP:
    """Records the conversation. Mirrors smtplib.SMTP's context-manager shape."""

    instances = []

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.started_tls = False
        self.login_args = None
        self.sent = []
        self.refused = {}
        self.quit_called = False
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.quit_called = True
        return False

    def starttls(self):
        self.started_tls = True

    def login(self, username, password):
        self.login_args = (username, password)

    def send_message(self, message):
        self.sent.append(message)
        return self.refused


@pytest.fixture(autouse=True)
def reset():
    FakeSMTP.instances = []


@pytest.fixture
def app():
    return create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake", **FULL})


def _patch(monkeypatch, factory=FakeSMTP):
    monkeypatch.setattr(smtp_client.smtplib, "SMTP", factory)


# --------------------------------------------------------------------------- happy path
def test_sends_one_plain_text_message_over_starttls(app, monkeypatch):
    _patch(monkeypatch)
    with app.app_context():
        assert send_email("family@example.lk", "Claim approved", "Your claim HEC-2026-0001 …") is True

    smtp = FakeSMTP.instances[0]
    assert (smtp.host, smtp.port) == ("smtp.example.lk", 587)
    # Credentials must never travel before the TLS upgrade.
    assert smtp.started_tls is True
    assert smtp.login_args == ("user", "pw")

    message = smtp.sent[0]
    assert message["To"] == "family@example.lk"
    assert message["Subject"] == "Claim approved"
    assert message["From"] == "HEC Compensation Platform <noreply@example.lk>"
    assert message.get_content_type() == "text/plain"
    assert "HEC-2026-0001" in message.get_content()


def test_the_sender_name_is_configurable(monkeypatch):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake", **FULL,
                      "SMTP_FROM_NAME": "DWC Compensation"})
    _patch(monkeypatch)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is True
    assert FakeSMTP.instances[0].sent[0]["From"] == "DWC Compensation <noreply@example.lk>"


def test_a_non_numeric_port_falls_back_to_submission_587(monkeypatch):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake", **FULL,
                      "SMTP_PORT": "not-a-number"})
    _patch(monkeypatch)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is True
    assert FakeSMTP.instances[0].port == 587


# --------------------------------------------------------------------------- failures never raise
def test_unconfigured_returns_false_without_opening_a_connection(monkeypatch):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})
    _patch(monkeypatch)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is False
    assert FakeSMTP.instances == []


@pytest.mark.parametrize("boom", [
    smtplib.SMTPAuthenticationError(535, b"bad credentials"),
    smtplib.SMTPRecipientsRefused({"a@b.lk": (550, b"unknown")}),
    smtplib.SMTPServerDisconnected("closed"),
    OSError("dns failure"),          # not an SMTPException, and must be just as survivable
    TimeoutError("timed out"),
])
def test_any_transport_failure_is_reported_as_false_not_raised(app, monkeypatch, boom):
    class Exploding(FakeSMTP):
        def send_message(self, message):
            raise boom

    _patch(monkeypatch, Exploding)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is False


def test_a_refused_recipient_is_a_failure_not_a_success(app, monkeypatch):
    class Refusing(FakeSMTP):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self.refused = {"a@b.lk": (550, b"mailbox unavailable")}

    _patch(monkeypatch, Refusing)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is False


def test_a_failure_to_connect_at_all_is_survivable(app, monkeypatch):
    def refuse(*a, **k):
        raise ConnectionRefusedError("no route")

    _patch(monkeypatch, refuse)
    with app.app_context():
        assert send_email("a@b.lk", "s", "b") is False


# --------------------------------------------------------------------------- what reaches the log
def test_no_full_address_and_no_password_ever_reaches_the_log(app, monkeypatch, caplog):
    class Exploding(FakeSMTP):
        def send_message(self, message):
            raise smtplib.SMTPAuthenticationError(535, b"bad credentials")

    _patch(monkeypatch, Exploding)
    with app.app_context(), caplog.at_level(logging.DEBUG):
        send_email("villager@example.lk", "s", "b")

    blob = caplog.text
    assert "villager@example.lk" not in blob
    assert "v***@example.lk" in blob
    # The credential must not be logged even while reporting an authentication failure.
    assert "pw" not in blob.replace("password", "").replace("Password", "")


@pytest.mark.parametrize("address,expected", [
    ("villager@example.lk", "v***@example.lk"),
    ("a@b.lk", "a***@b.lk"),
    ("@example.lk", "***@example.lk"),
    ("not-an-address", "<invalid>"),
    (None, "<invalid>"),
])
def test_masking_keeps_the_domain_and_drops_the_local_part(address, expected):
    assert _mask(address) == expected


# --------------------------------------------------------------------------- the predicate
def test_email_configured_is_false_outside_an_application_context():
    """A background thread or an import-time probe must get "unconfigured", not an exception."""
    assert email_configured() is False
