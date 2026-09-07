"""Outbound Web Push wrapper.

The third sibling of sms/twilio_client.py and email/sendgrid_client.py, and the same shape: never
raises, reads credentials from `current_app.config`, and is a thin enough seam that tests can
monkeypatch `send_push` with no network and no keys.

It differs from the other two in one way that matters: there is no vendor. Web Push is a W3C
standard delivered by the browser's own push service (FCM for Chrome, Mozilla's for Firefox), and
the server authenticates with a VAPID keypair it generates itself. No account, no contract, and no
registered business entity -- which is precisely the wall that stopped SMS (§7.2).

Returns a small result object rather than a bare bool, because the caller must distinguish "this
failed, try again next time" from "this subscription is dead, delete the row". A push service
answers 404 or 410 Gone for a subscription the browser has discarded, and a table that never
prunes those degrades every subsequent send.
"""
import json
import logging
from dataclasses import dataclass

from flask import current_app
from pywebpush import WebPushException, webpush

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 15

# Status codes a push service returns for a subscription that no longer exists. The row should be
# deleted rather than retried; the browser will create a fresh subscription if the user returns.
GONE_STATUSES = (404, 410)


@dataclass(frozen=True)
class PushResult:
    delivered: bool
    gone: bool = False


def push_configured() -> bool:
    """True when a VAPID keypair is present. The subscribe endpoint reports push unavailable
    rather than accepting subscriptions it could never deliver to."""
    return bool(current_app.config.get("VAPID_PRIVATE_KEY")
                and current_app.config.get("VAPID_PUBLIC_KEY"))


def send_push(endpoint: str, p256dh: str, auth: str, payload: dict) -> PushResult:
    """Deliver one encrypted push message to one browser subscription.

    Never raises, for the same reason send_sms and send_email never raise: this runs inside the
    same database transaction as a case's already-applied status write, and an exception here
    would roll back the transition the message was announcing.
    """
    if not push_configured():
        logger.info("push not sent: VAPID keys are not configured")
        return PushResult(delivered=False)

    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=json.dumps(payload),
            vapid_private_key=current_app.config["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": current_app.config["VAPID_SUBJECT"]},
            timeout=TIMEOUT_SECONDS,
        )
        return PushResult(delivered=True)
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in GONE_STATUSES:
            # Not an error worth logging loudly: the user cleared site data, uninstalled the PWA,
            # or the browser rotated the subscription. Expected churn.
            logger.info("push subscription is gone (HTTP %s); it will be deleted", status)
            return PushResult(delivered=False, gone=True)
        logger.warning("push delivery failed (HTTP %s)", status)
        return PushResult(delivered=False)
    except Exception:
        # A malformed key, a missing config value, a DNS failure -- all must be survivable here.
        logger.exception("unexpected failure sending push")
        return PushResult(delivered=False)
