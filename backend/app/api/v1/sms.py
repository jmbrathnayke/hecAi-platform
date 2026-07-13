"""SMS fallback intake webhook (Story 3.6, FR-1.4).

POST /api/v1/sms/inbound — Twilio inbound-SMS webhook. A field officer with no data connectivity
sends a terse structured SMS ("REPORT <NIC> <LAT>,<LNG> <TYPE>") to the DWC hotline; Twilio
forwards it here, we parse it, resolve the officer from the sender's number, create a case, and
reply with the canonical id as a receipt.

Contract quirks that drive the design:
  * Twilio RETRIES the webhook on any non-2xx or timeout. So every *business* outcome (bad format,
    unregistered sender, duplicate delivery) returns HTTP 200 and delivers the outcome as a reply
    SMS. Only a genuinely invalid signature returns 403 (a spoof must not be retried).
  * The SMS path mints a fresh server-side offline_id per call, so it cannot dedupe on offline_id
    the way the citizen path does. Twilio's MessageSid is stable across retries and is the
    idempotency key (UNIQUE column + ON CONFLICT) — mirrors the offline_id guard in cases.py.

Officer identity here is CALLER-ID TRUST (sender number → users.mobile_number), which is weaker
than the cryptographic JWT path. Acceptable for a last-resort fallback where the alternative is no
record at all; noted as a known limitation in the story.
"""
import hashlib
import re
import uuid
from datetime import datetime, timezone

import psycopg2
from flask import Blueprint, current_app, request
from twilio.request_validator import RequestValidator

from app.infrastructure.audit import write_audit_log
from app.infrastructure.ml import compensation
from app.infrastructure.sms.twilio_client import send_sms

sms_bp = Blueprint("sms", __name__)

# Structured-message grammar. Body is uppercased before matching, so NIC letters are [VX].
NIC_RE = re.compile(r"^([0-9]{9}[VX]|[0-9]{12})$")
COORD_RE = re.compile(r"^(-?\d+\.?\d*),(-?\d+\.?\d*)$")
DAMAGE_MAP = {"CROP": "crop", "PROPERTY": "property", "COMBINED": "combined", "NONE": "none"}

ERROR_REPLY = (
    "Invalid format. Send: REPORT <NIC> <LAT>,<LNG> <TYPE>. "
    "Types: CROP/PROPERTY/COMBINED/NONE"
)
UNREGISTERED_REPLY = "Your number is not registered as a DWC officer. Contact admin."


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _validate_twilio_signature(req) -> bool:
    """Verify the request really came from Twilio (CRITICAL: prevents anyone POSTing fake cases).

    The signature is computed over the exact PUBLIC URL Twilio called. Behind a proxy/load
    balancer, `request.url` is the internal http:// URL and will NOT match, so we validate against
    the configured public webhook URL when present (falling back to request.url only in local/dev
    where they coincide)."""
    token = current_app.config.get("TWILIO_AUTH_TOKEN")
    if not token:
        # No token configured means we cannot verify authenticity — fail closed.
        return False
    validator = RequestValidator(token)
    url = current_app.config.get("TWILIO_PUBLIC_WEBHOOK_URL") or req.url
    signature = req.headers.get("X-Twilio-Signature", "")
    return validator.validate(url, req.form.to_dict(), signature)


@sms_bp.route("/sms/inbound", methods=["POST"])
def inbound_sms():
    if not _validate_twilio_signature(request):
        # A spoofed/unsigned request. 403 (no reply, no side effects) — Twilio does not retry this.
        return "", 403

    from_number = request.form.get("From", "")
    message_sid = request.form.get("MessageSid") or None
    body = request.form.get("Body", "").strip().upper()

    def reply(msg: str):
        # Every business outcome is an HTTP 200 (Twilio retries non-2xx) with the outcome as an SMS.
        if from_number:
            send_sms(from_number, msg)
        return "", 200

    # --- Parse (AC4 / AC7: anything not matching the grammar, incl. USSD-shaped text, replies) ---
    parts = body.split()
    if len(parts) != 4 or parts[0] != "REPORT":
        return reply(ERROR_REPLY)

    _, nic, coords_raw, damage_raw = parts
    if not NIC_RE.match(nic):
        return reply(ERROR_REPLY)
    coord_match = COORD_RE.match(coords_raw)
    if not coord_match:
        return reply(ERROR_REPLY)
    lat, lng = float(coord_match.group(1)), float(coord_match.group(2))
    # Range-gate the coordinates. COORD_RE only checks shape, so a regex-valid but impossible pair
    # (e.g. "91,200") would otherwise be stored as a real case with a nonsense location, and a
    # value with 4+ integer digits would overflow gps_lat/lng NUMERIC(10,7) into a psycopg2 error
    # and a misleading "try again" reply. The PWA path is shielded by GPS/MapPinPicker; SMS is not.
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return reply(ERROR_REPLY)
    damage_category = DAMAGE_MAP.get(damage_raw)
    if not damage_category:
        return reply(ERROR_REPLY)

    year = str(datetime.now(timezone.utc).year)

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # AC5: resolve the officer from the sender's number (caller-id trust).
                    cur.execute(
                        "SELECT supabase_uid FROM users WHERE mobile_number = %s",
                        (from_number,),
                    )
                    officer_row = cur.fetchone()
                    if officer_row is None:
                        return reply(UNREGISTERED_REPLY)
                    officer_id = str(officer_row[0])

                    # AC6 fast path: a redelivered MessageSid returns the first case's ids without
                    # burning a sequence value or creating a duplicate.
                    if message_sid is not None:
                        cur.execute(
                            "SELECT canonical_id, offline_id FROM cases "
                            "WHERE twilio_message_sid = %s",
                            (message_sid,),
                        )
                        existing = cur.fetchone()
                        if existing is not None:
                            return reply(
                                f"Case {existing[0]} recorded. Ref: {existing[1]}"
                            )

                    offline_id = str(uuid.uuid4())
                    # submitter_identity_hash mirrors the SHAPE the citizen path uses — an
                    # offline_id-scoped SHA-256 (the frontend hashes offline_id:nicCiphertext; SMS
                    # has no ciphertext, so it hashes offline_id:nic). It is a per-submission opaque
                    # tag, NOT a cross-channel citizen key (the two channels can never produce the
                    # same value); citizen identification is via citizen_nic_plain.
                    identity_hash = hashlib.sha256(f"{offline_id}:{nic}".encode()).hexdigest()
                    cur.execute("SELECT nextval('hec_canonical_seq')")
                    seq = cur.fetchone()[0]
                    canonical_id = f"HEC-{year}-{seq:04d}"

                    # Race-safe insert: a concurrent duplicate delivery (same MessageSid) yields no
                    # row (ON CONFLICT DO NOTHING); fall back to the winner's ids (AC6).
                    cur.execute(
                        """INSERT INTO cases
                             (offline_id, canonical_id, damage_category, gps_lat, gps_lng,
                              submitter_identity_hash, officer_id, submitted_by_officer,
                              submitted_via, citizen_nic_plain, twilio_message_sid, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE,
                                   'sms', %s, %s, 'Submitted')
                           ON CONFLICT (twilio_message_sid) DO NOTHING
                           RETURNING id""",
                        (
                            offline_id,
                            canonical_id,
                            damage_category,
                            lat,
                            lng,
                            identity_hash,
                            officer_id,
                            nic,
                            message_sid,
                        ),
                    )
                    row = cur.fetchone()
                    if row is None:
                        cur.execute(
                            "SELECT canonical_id, offline_id FROM cases "
                            "WHERE twilio_message_sid = %s",
                            (message_sid,),
                        )
                        won = cur.fetchone()
                        return reply(f"Case {won[0]} recorded. Ref: {won[1]}")

                    case_id = row[0]
                    write_audit_log(
                        cur,
                        case_id,
                        "sms_submission",
                        officer_id,
                        {"submitted_via": "sms", "twilio_message_sid": message_sid},
                    )
                    # No district picker or AI classification exists over SMS (Story 5.2
                    # Tasks 7/8 explicitly don't touch this file) -- district/ai_severity
                    # stay at their default None, degrading to the "unknown"/neutral-
                    # multiplier behavior compensation.py already handles.
                    compensation.estimate_and_store(
                        cur, case_id, damage_category, None, datetime.now(timezone.utc),
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("sms inbound insert failed")
        # DB failure: return 200 so Twilio does not hammer us with retries on an outage, but tell
        # the officer it did not go through so they can try again later.
        return reply("Could not record your report right now. Please try again shortly.")

    return reply(f"Case {canonical_id} recorded. Ref: {offline_id}")
