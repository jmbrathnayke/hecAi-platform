"""Tests for POST /api/v1/sms/inbound (Story 3.6, SMS fallback channel).

No real Twilio and no Postgres: the DB is a FakeConn/FakeCursor implementing exactly the SQL the
webhook issues (resolve officer by mobile, idempotency select on MessageSid, sequence, insert case,
insert audit), the Twilio signature validator is monkeypatched, and send_sms is captured into a
list. This exercises parsing, officer resolution, idempotency, the recorded row shape, and the
HTTP-200-on-business-error / 403-on-bad-signature contract without external services.
"""
import hashlib
from typing import Any

import pytest

from app import create_app

OFFICER_MOBILE = "+94771234567"
OFFICER_UID = "11111111-1111-4111-8111-111111111111"


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        elif "SELECT supabase_uid FROM users" in sql:
            mobile = params[0]
            uid = self.store["users"].get(mobile)
            self._result = (uid,) if uid is not None else None
        elif "SELECT canonical_id, offline_id FROM cases" in sql:
            sid = params[0]
            row = self.store["cases_by_sid"].get(sid)
            self._result = (row["canonical_id"], row["offline_id"]) if row else None
        elif "nextval" in sql:
            self.store["seq"] += 1
            self._result = (self.store["seq"],)
        elif "INSERT INTO cases" in sql:
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
                mobile,
            ) = params
            # ON CONFLICT (twilio_message_sid) DO NOTHING → no row when the sid already exists.
            if message_sid is not None and message_sid in self.store["cases_by_sid"]:
                self._result = None
                return
            self.store["next_id"] += 1
            row = {
                "id": self.store["next_id"],
                "offline_id": offline_id,
                "canonical_id": canonical_id,
                "damage_category": damage_category,
                "gps_lat": lat,
                "gps_lng": lng,
                "submitter_identity_hash": identity_hash,
                "officer_id": officer_id,
                "submitted_by_officer": True,
                "submitted_via": "sms",
                "citizen_nic_plain": nic,
                "twilio_message_sid": message_sid,
                "citizen_mobile_plain": mobile,
                "status": "Submitted",
            }
            self.store["cases"].append(row)
            if message_sid is not None:
                self.store["cases_by_sid"][message_sid] = row
            self._result = (row["id"],)
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.store["audit"].append(
                {
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": metadata,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
            self._result = None
        else:  # pragma: no cover - unexpected SQL
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._result


class FakeConn:
    def __init__(self, store):
        self.store = store
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.store)

    def close(self):
        self.closed = True


@pytest.fixture
def store():
    return {
        "users": {OFFICER_MOBILE: OFFICER_UID},
        "cases": [],
        "cases_by_sid": {},
        "audit": [],
        "seq": 0,
        "next_id": 0,
    }


@pytest.fixture
def sent():
    return []


@pytest.fixture
def estimate_spy(monkeypatch):
    """Story 5.2: isolate sms.py's behavioral tests from the real ML model while still
    letting tests assert exactly how estimate_and_store() was called. SMS has no
    district picker or AI classification, so district/ai_severity should always be None."""
    calls = []

    def fake_estimate_and_store(cur, case_id, damage_category, ds_division_id, submitted_at,
                                 district=None, ai_severity=None):
        calls.append({
            "case_id": case_id, "damage_category": damage_category,
            "ds_division_id": ds_division_id, "district": district, "ai_severity": ai_severity,
        })
        return None

    monkeypatch.setattr("app.api.v1.sms.compensation.estimate_and_store", fake_estimate_and_store)
    return calls


@pytest.fixture
def client(monkeypatch, store, sent, estimate_spy):
    app = create_app(
        {
            "TESTING": True,
            "DATABASE_URL": "postgresql://fake",
            "TWILIO_AUTH_TOKEN": "fake-token",
        }
    )
    monkeypatch.setattr("app.api.v1.sms._get_connection", lambda: FakeConn(store))
    # Signature is validated in its own unit path; default to authentic here.
    monkeypatch.setattr("app.api.v1.sms._validate_twilio_signature", lambda req: True)
    monkeypatch.setattr(
        "app.api.v1.sms.send_sms", lambda to, body: sent.append({"to": to, "body": body})
    )
    return app.test_client()


def _form(body, from_number=OFFICER_MOBILE, sid="SM-msg-1"):
    return {"From": from_number, "Body": body, "MessageSid": sid}


# --- happy path (AC2, AC3) -------------------------------------------------

def test_valid_sms_creates_case_audit_and_reply(client, store, sent):
    res = client.post(
        "/api/v1/sms/inbound", data=_form("REPORT 200012345678 7.2906,80.6337 CROP")
    )
    assert res.status_code == 200
    assert len(store["cases"]) == 1
    row = store["cases"][0]
    assert row["damage_category"] == "crop"
    assert float(row["gps_lat"]) == 7.2906 and float(row["gps_lng"]) == 80.6337
    assert row["submitted_via"] == "sms"
    assert row["submitted_by_officer"] is True
    assert row["officer_id"] == OFFICER_UID
    assert row["status"] == "Submitted"
    assert row["citizen_nic_plain"] == "200012345678"
    # submitter_identity_hash is an offline_id-scoped SHA-256 (mirrors the citizen path's shape),
    # a per-submission opaque tag — NOT sha256(nic) and NOT cross-channel matchable.
    assert (
        row["submitter_identity_hash"]
        == hashlib.sha256(f"{row['offline_id']}:200012345678".encode()).hexdigest()
    )
    # Audit row recorded.
    assert len(store["audit"]) == 1
    assert store["audit"][0]["event"] == "sms_submission"
    assert store["audit"][0]["actor_id"] == OFFICER_UID
    # Receipt SMS with canonical id + offline ref.
    assert len(sent) == 1
    assert sent[0]["to"] == OFFICER_MOBILE
    assert sent[0]["body"] == f"Case {row['canonical_id']} recorded. Ref: {row['offline_id']}"
    assert row["canonical_id"].startswith("HEC-") and row["canonical_id"].endswith("0001")


def test_old_style_nic_with_letter_accepted(client, store):
    res = client.post(
        "/api/v1/sms/inbound", data=_form("REPORT 901234567V 7.29,80.63 PROPERTY")
    )
    assert res.status_code == 200
    assert len(store["cases"]) == 1
    assert store["cases"][0]["citizen_nic_plain"] == "901234567V"  # uppercased
    assert store["cases"][0]["damage_category"] == "property"


# --- signature (AC1) -------------------------------------------------------

def test_invalid_signature_returns_403_no_side_effects(monkeypatch, client, store, sent):
    monkeypatch.setattr("app.api.v1.sms._validate_twilio_signature", lambda req: False)
    res = client.post(
        "/api/v1/sms/inbound", data=_form("REPORT 200012345678 7.29,80.63 CROP")
    )
    assert res.status_code == 403
    assert store["cases"] == []
    assert sent == []


# --- parse errors (AC4) ----------------------------------------------------

@pytest.mark.parametrize(
    "body",
    [
        "REPORT 200012345678",  # too few tokens
        "HELLO 200012345678 7.29,80.63 CROP",  # wrong keyword
        "REPORT 123 7.29,80.63 CROP",  # bad NIC
        "REPORT 200012345678 not-coords CROP",  # bad coords
        "REPORT 200012345678 91,80.63 CROP",  # latitude out of range (>90)
        "REPORT 200012345678 7.29,200 CROP",  # longitude out of range (>180)
        "REPORT 200012345678 1000,80.63 CROP",  # 4-digit lat would overflow NUMERIC(10,7)
        "REPORT 200012345678 7.29,80.63 FIRE",  # bad damage type
    ],
)
def test_bad_format_replies_200_no_case(client, store, sent, body):
    res = client.post("/api/v1/sms/inbound", data=_form(body))
    assert res.status_code == 200
    assert store["cases"] == []
    assert sent[0]["body"].startswith("Invalid format.")


# --- USSD out of scope (AC7): a USSD-shaped string just hits the parse-error path, no USSD code --

def test_ussd_shaped_body_hits_parse_error(client, store, sent):
    res = client.post("/api/v1/sms/inbound", data=_form("*123#"))
    assert res.status_code == 200
    assert store["cases"] == []
    assert sent[0]["body"].startswith("Invalid format.")


# --- unregistered sender (AC5) --------------------------------------------

def test_unregistered_number_replies_200_no_case(client, store, sent):
    res = client.post(
        "/api/v1/sms/inbound",
        data=_form("REPORT 200012345678 7.29,80.63 CROP", from_number="+94770000000"),
    )
    assert res.status_code == 200
    assert store["cases"] == []
    assert sent[0]["body"] == "Your number is not registered as a DWC officer. Contact admin."


# --- idempotency on redelivery (AC6) --------------------------------------

def test_redelivered_message_sid_creates_no_duplicate(client, store, sent):
    form = _form("REPORT 200012345678 7.29,80.63 CROP", sid="SM-dup")
    first = client.post("/api/v1/sms/inbound", data=form)
    second = client.post("/api/v1/sms/inbound", data=form)
    assert first.status_code == 200 and second.status_code == 200
    # Exactly one case despite two deliveries.
    assert len(store["cases"]) == 1
    # Both replies quote the same canonical id + ref.
    assert sent[0]["body"] == sent[1]["body"]
    # The sequence was only consumed once (no gap-burning on redelivery).
    assert store["seq"] == 1


def test_distinct_message_sids_create_distinct_cases(client, store):
    client.post(
        "/api/v1/sms/inbound",
        data=_form("REPORT 200012345678 7.29,80.63 CROP", sid="SM-a"),
    )
    client.post(
        "/api/v1/sms/inbound",
        data=_form("REPORT 199512345678 7.10,80.10 PROPERTY", sid="SM-b"),
    )
    assert len(store["cases"]) == 2
    assert store["cases"][0]["canonical_id"] != store["cases"][1]["canonical_id"]


# --- Story 5.2: compensation estimation wired into the SMS path, always district/severity-blind ---


def test_sms_case_triggers_compensation_estimate_with_no_district_or_severity(
    client, store, estimate_spy
):
    res = client.post(
        "/api/v1/sms/inbound", data=_form("REPORT 200012345678 7.2906,80.6337 CROP")
    )
    assert res.status_code == 200
    assert len(estimate_spy) == 1
    assert estimate_spy[0]["damage_category"] == "crop"
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ds_division_id"] is None
    assert estimate_spy[0]["ai_severity"] is None


def test_sms_redelivery_does_not_re_trigger_compensation_estimate(client, store, estimate_spy):
    form = _form("REPORT 200012345678 7.29,80.63 CROP", sid="SM-dup2")
    client.post("/api/v1/sms/inbound", data=form)
    client.post("/api/v1/sms/inbound", data=form)
    assert len(estimate_spy) == 1


# --- optional 5th token: citizen mobile (Story 5.6, FR-6.3) -----------------------------------


def test_5_token_message_with_valid_mobile_stores_citizen_mobile_plain(client, store):
    res = client.post(
        "/api/v1/sms/inbound",
        data=_form("REPORT 200012345678 7.2906,80.6337 CROP 0771234567"),
    )
    assert res.status_code == 200
    assert len(store["cases"]) == 1
    assert store["cases"][0]["citizen_mobile_plain"] == "0771234567"


def test_5_token_message_with_invalid_mobile_replies_error_no_case(client, store, sent):
    res = client.post(
        "/api/v1/sms/inbound",
        data=_form("REPORT 200012345678 7.29,80.63 CROP 123"),
    )
    assert res.status_code == 200
    assert store["cases"] == []
    assert sent[0]["body"].startswith("Invalid format.")


def test_4_token_message_still_valid_with_no_mobile(client, store):
    # Backward compatibility: the original grammar (no 5th token) must keep working exactly as
    # before -- citizen_mobile_plain stays NULL.
    res = client.post(
        "/api/v1/sms/inbound", data=_form("REPORT 200012345678 7.29,80.63 CROP")
    )
    assert res.status_code == 200
    assert store["cases"][0]["citizen_mobile_plain"] is None
