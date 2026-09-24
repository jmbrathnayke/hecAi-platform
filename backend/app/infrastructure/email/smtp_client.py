"""Outbound email over SMTP.

The email sibling of push/webpush_client.py, and deliberately the same shape: a thin seam that
never raises, returns True/False, and reads credentials from `current_app.config` (loaded from env
in create_app) rather than at import time, so tests can monkeypatch `send_email` with no mail
account and no network.

WHY SMTP RATHER THAN ONE PROVIDER'S REST API. This replaced a SendGrid-specific client. SendGrid
withdrew its free tier, and because the transport spoke SendGrid's own JSON dialect, changing
provider meant changing code. SMTP is the interface every provider offers, so the provider is now a
deployment decision (five env vars) instead of a code decision -- and it is the same credential set
Supabase Auth is given for its own confirmation and sign-in mail, so one mailbox serves both.

STARTTLS on the submission port (587), not implicit TLS on 465: it is what Brevo, Gmail, Mailgun,
Postmark and SES all accept, and `smtplib.SMTP.starttls()` refuses to continue if the upgrade fails,
so credentials are never sent in the clear.
"""
import logging
import smtplib
from email.message import EmailMessage

from flask import current_app

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 20
DEFAULT_PORT = 587


def _mask(address: str) -> str:
    """Reduce an address to something safe to log.

    An email address is a durable identifier that reaches the person directly, application logs are
    retained and shipped off-host, and NFR-3.2 is explicit about not widening the exposure surface
    of citizen contact data. The domain is kept because that is what actually helps diagnose a
    delivery failure; the local part is not.
    """
    if not isinstance(address, str) or "@" not in address:
        return "<invalid>"
    local, _, domain = address.partition("@")
    head = local[:1] if local else ""
    return f"{head}***@{domain}"


def _settings():
    """-> (host, port, username, password, from_email, from_name). Missing values come back falsy."""
    config = current_app.config
    try:
        port = int(config.get("SMTP_PORT") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    return (
        config.get("SMTP_HOST"),
        port,
        config.get("SMTP_USERNAME"),
        config.get("SMTP_PASSWORD"),
        config.get("SMTP_FROM_EMAIL"),
        config.get("SMTP_FROM_NAME") or "HEC Compensation Platform",
    )


def email_configured() -> bool:
    """-> True if this deployment holds the credentials needed to send anything at all.

    ADVISORY, NOT A PRECONDITION. send_email() performs this same check itself and remains safe to
    call without consulting this first. The two are deliberately not collapsed into one: a caller
    that never looks at this predicate must keep working exactly as before.

    It exists so a caller writing an audit trail can tell a deployment that was never given mail
    credentials from one whose mail is being rejected. Both make send_email() return False, and
    recording both as a delivery failure made an unprovisioned deployment indistinguishable from a
    broken one for anyone reading the log afterwards -- including in §7.3, where email is
    documented as implemented but not provisioned.
    """
    try:
        host, _, username, password, from_email, _ = _settings()
        return bool(host and username and password and from_email)
    except Exception:
        # No application context (a background thread, an import-time probe). Unconfigured is the
        # safe answer: this sits on a notification path that must never break its caller, and the
        # worst outcome of a false negative is one audit row naming the wrong reason.
        return False


def send_email(to: str, subject: str, body: str) -> bool:
    """Send one plain-text email. Returns True on acceptance, False on any failure.

    Never raises, for the same reason send_push never raises: this runs inside the same database
    transaction as a case's already-applied status write, and an unhandled exception here would
    roll that transition back. A notification failing must not undo the decision it was announcing.

    Catches Exception broadly rather than smtplib.SMTPException alone -- a missing credential raises
    out of current_app.config, and DNS and TLS failures surface as OSError/ssl.SSLError, none of
    which are SMTPException. All of them must be as survivable as a rejected recipient.
    """
    try:
        host, port, username, password, from_email, from_name = _settings()

        if not (host and username and password and from_email):
            # Unconfigured is a normal state in development and in any deployment that has not
            # provisioned email yet. Log at info: it is not an error, and it must not page anyone.
            logger.info("email not sent to %s: SMTP is not configured", _mask(to))
            return False

        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = f"{from_name} <{from_email}>"
        message["To"] = to
        message.set_content(body)

        with smtplib.SMTP(host, port, timeout=TIMEOUT_SECONDS) as smtp:
            smtp.starttls()
            smtp.login(username, password)
            # -> {} when every recipient was accepted; a non-empty dict names those refused.
            refused = smtp.send_message(message)

        if refused:
            logger.error("SMTP refused mail to %s: %s", _mask(to), list(refused.values())[:2])
            return False
        return True
    except Exception:
        # The provider puts the actionable reason in the exception (unverified sender, bad key,
        # over quota); without it a failure is indistinguishable from a network timeout.
        logger.exception("failed to send email to %s", _mask(to))
        return False
