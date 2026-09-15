"""Outbound email wrapper.

The email sibling of sms/twilio_client.py, and deliberately the same shape: a thin seam that never
raises, returns True/False, and reads credentials from `current_app.config` (loaded from env in
create_app) rather than at import time, so tests can monkeypatch `send_email` with no SendGrid
account and no network.

Uses `requests` (already in requirements.txt) against SendGrid's v3 REST API rather than the
`sendgrid` SDK. The call is one POST with a JSON body; an SDK would add a dependency for no gain,
and the deployment target already carries requests for other reasons.

WHY SENDGRID AND NOT SMS. Sri Lankan carriers accept application-to-person SMS only from a sender
identity registered with each operator, which requires a locally registered business entity. Email
has no equivalent gate: SendGrid's Single Sender Verification needs only an address the sender
controls. See §7.2 of the dissertation.
"""
import logging

import requests
from flask import current_app

logger = logging.getLogger(__name__)

SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send"
TIMEOUT_SECONDS = 15


def _mask(address: str) -> str:
    """Reduce an address to something safe to log.

    twilio_client logs the destination number in full. That precedent is not followed here: an
    email address is a durable identifier that reaches the person directly, application logs are
    retained and shipped off-host, and NFR-3.2 is explicit about not widening the exposure surface
    of citizen contact data. The domain is kept because that is what actually helps diagnose a
    delivery failure; the local part is not.
    """
    if not isinstance(address, str) or "@" not in address:
        return "<invalid>"
    local, _, domain = address.partition("@")
    head = local[:1] if local else ""
    return f"{head}***@{domain}"


def email_configured() -> bool:
    """-> True if this deployment holds the credentials needed to send anything at all.

    ADVISORY, NOT A PRECONDITION. send_email() performs this same check itself and remains safe to
    call without consulting this first. The two are deliberately not collapsed into one: a caller
    that never looks at this predicate must keep working exactly as before.

    It exists so a caller writing an audit trail can tell a deployment that was never given a
    SendGrid key from one whose mail is being rejected. Both make send_email() return False, and
    recording both as a delivery failure made an unprovisioned deployment indistinguishable from a
    broken one for anyone reading the log afterwards -- including in §7.3, where email is
    documented as implemented but not provisioned.
    """
    try:
        return bool(current_app.config.get("SENDGRID_API_KEY")
                    and current_app.config.get("SENDGRID_FROM_EMAIL"))
    except Exception:
        # No application context (a background thread, an import-time probe). Unconfigured is the
        # safe answer: this sits on a notification path that must never break its caller, and the
        # worst outcome of a false negative is one audit row naming the wrong reason.
        return False


def send_email(to: str, subject: str, body: str) -> bool:
    """Send one plain-text email. Returns True on acceptance, False on any failure.

    Never raises, for the same reason send_sms never raises: this runs inside the same database
    transaction as a case's already-applied status write, and an unhandled exception here would
    roll that transition back. A notification failing must not undo the decision it was announcing.

    Catches Exception broadly rather than requests.RequestException alone -- a missing or
    misconfigured SENDGRID_API_KEY raises a KeyError out of current_app.config before any request
    is made, and that must be as survivable as a network timeout.

    SendGrid returns 202 Accepted, not 200, when a message is queued.
    """
    try:
        api_key = current_app.config["SENDGRID_API_KEY"]
        from_email = current_app.config["SENDGRID_FROM_EMAIL"]
        from_name = current_app.config.get("SENDGRID_FROM_NAME") or "HEC Compensation Platform"

        if not api_key or not from_email:
            # Unconfigured is a normal state in development and in any deployment that has not
            # provisioned email yet. Log at info: it is not an error, and it must not page anyone.
            logger.info("email not sent to %s: SendGrid is not configured", _mask(to))
            return False

        response = requests.post(
            SENDGRID_ENDPOINT,
            timeout=TIMEOUT_SECONDS,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "personalizations": [{"to": [{"email": to}]}],
                "from": {"email": from_email, "name": from_name},
                "subject": subject,
                "content": [{"type": "text/plain", "value": body}],
            },
        )

        if response.status_code in (200, 202):
            return True

        # SendGrid puts the actionable reason in the body (unverified sender, suppressed address,
        # over quota). Log it: without it a 403 is indistinguishable from a 400.
        logger.error(
            "SendGrid rejected mail to %s: HTTP %s %s",
            _mask(to), response.status_code, response.text[:400],
        )
        return False
    except Exception:
        logger.exception("failed to send email to %s", _mask(to))
        return False
