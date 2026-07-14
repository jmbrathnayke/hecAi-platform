"""Outbound SMS wrapper (Story 3.6, FR-1.4).

A thin seam over the Twilio REST client so the inbound webhook can send reply messages
(receipts, format hints, "not registered" notices). Kept tiny and side-effect-free at import
time so tests can monkeypatch `send_sms` without a real Twilio account.

Credentials are read from `current_app.config` (loaded from env in create_app), never from a
module-level environment read — this keeps them injectable in tests and consistent with how the
rest of the backend resolves config.
"""
import logging

from flask import current_app
from twilio.rest import Client

logger = logging.getLogger(__name__)


def get_twilio_client() -> Client:
    return Client(
        current_app.config["TWILIO_ACCOUNT_SID"],
        current_app.config["TWILIO_AUTH_TOKEN"],
    )


def send_sms(to: str, body: str) -> bool:
    """Send one SMS. A delivery failure is logged, never raised: by the time a reply is sent the
    case is already committed, and Twilio must still receive our HTTP 200 (raising here would turn
    a successful submission into a 500 that Twilio then retries). Returns True/False so callers
    that need to distinguish success from failure (Story 5.6's notification_service, logging
    sms_sent vs. sms_failed) can -- existing callers that only want the never-raises guarantee
    (sms.py's reply-SMS flow) simply ignore the return value.

    Catches Exception broadly, not just TwilioRestException (code review, Story 5.6): a missing/
    misconfigured credential raises inside get_twilio_client() itself, and a bare network error
    from the underlying HTTP client isn't a TwilioRestException either -- either would otherwise
    escape notify_status_change() and roll back the case's own already-applied status transition,
    which is exactly what this function's docstring promises never happens (AC5)."""
    try:
        client = get_twilio_client()
        client.messages.create(
            to=to,
            from_=current_app.config["TWILIO_FROM_NUMBER"],
            body=body,
        )
        return True
    except Exception:
        logger.exception("failed to send reply SMS to %s", to)
        return False
