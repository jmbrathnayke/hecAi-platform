"""Tests for infrastructure/sms/notification_service.py::notify_status_change (Story 5.6).

Uses the same small in-memory fake table style as test_audit.py (since notify_status_change
calls the REAL write_audit_log(), not a mock of it) plus a sms_templates lookup and a
monkeypatched send_sms captured into a list.
"""
import json

import pytest

from app.infrastructure.sms import notification_service

TEMPLATES = {
    ("si", "Approved"): "ඔබගේ HEC හිමිකම් පත්‍රය {ref} අනුමත කර ඇත. අනුමත මුදල: රු. {amount}.",
    ("si", "Rejected"): "ඔබගේ HEC හිමිකම් පත්‍රය {ref} ප්‍රතික්ෂේප කර ඇත.",
    ("si", "Under Review"): "ඔබගේ HEC හිමිකම් පත්‍රය {ref} සමාලෝචනය වෙමින් පවතී.",
    ("si", "Payment Processed"): "ඔබගේ HEC හිමිකම් පත්‍රය {ref} සඳහා ගෙවීම සිදු කර ඇත.",
}


class FakeCursor:
    def __init__(self):
        self.audit_rows = []
        self._result = None

    def execute(self, sql, params=()):
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.audit_rows[-1]["hash"],) if self.audit_rows else None
        elif "SELECT template FROM sms_templates" in sql:
            language, status = params
            template = TEMPLATES.get((language, status))
            self._result = (template,) if template is not None else None
        elif sql.startswith("INSERT INTO audit_log"):
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.audit_rows.append(
                {
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._result


@pytest.fixture
def cur():
    return FakeCursor()


@pytest.fixture
def sent(monkeypatch):
    calls = []
    monkeypatch.setattr(
        notification_service,
        "send_sms",
        lambda to, body: calls.append({"to": to, "body": body}) or True,
    )
    return calls


def test_no_mobile_skips_send_and_logs_sms_skipped_no_mobile(cur, sent):
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain=None,
        new_status="Rejected", admin_id="admin-1",
    )
    assert sent == []
    assert len(cur.audit_rows) == 1
    assert cur.audit_rows[0]["event"] == "sms_skipped_no_mobile"
    assert cur.audit_rows[0]["metadata"] == {"status": "Rejected"}


def test_mobile_present_sends_rendered_template_and_logs_sms_sent(cur, sent):
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain="0771234567",
        new_status="Rejected", admin_id="admin-1",
    )
    assert sent == [{"to": "0771234567", "body": TEMPLATES[("si", "Rejected")].replace("{ref}", "HEC-2026-0001")}]
    assert cur.audit_rows[0]["event"] == "sms_sent"
    assert cur.audit_rows[0]["metadata"] == {"status": "Rejected"}


def test_approved_status_renders_amount_placeholder(cur, sent):
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain="0771234567",
        new_status="Approved", admin_id="admin-1", amount_lkr=45000.0,
    )
    assert sent[0]["body"] == "ඔබගේ HEC හිමිකම් පත්‍රය HEC-2026-0001 අනුමත කර ඇත. අනුමත මුදල: රු. 45,000.00."


def test_send_failure_logs_sms_failed(cur, monkeypatch):
    monkeypatch.setattr(notification_service, "send_sms", lambda to, body: False)
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain="0771234567",
        new_status="Under Review", admin_id="admin-1",
    )
    assert cur.audit_rows[0]["event"] == "sms_failed"


def test_audit_metadata_never_contains_the_mobile_number(cur, sent):
    # CRITICAL #8 (privacy): the mobile number is already stored once on `cases`; it must never
    # be duplicated into the append-only audit_log metadata.
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain="0771234567",
        new_status="Rejected", admin_id="admin-1",
    )
    assert "0771234567" not in json.dumps(cur.audit_rows[0]["metadata"])


def test_missing_template_logs_sms_template_missing_and_does_not_raise(cur, sent):
    # Code review (Story 5.6): a status with no seeded (si, status) row must not crash --
    # notify_status_change runs inside the same DB transaction as the case's own status write
    # (AC1), so an unhandled exception here would roll back that already-applied transition.
    notification_service.notify_status_change(
        cur, case_id=1, canonical_id="HEC-2026-0001", citizen_mobile_plain="0771234567",
        new_status="No Such Status", admin_id="admin-1",
    )
    assert sent == []
    assert cur.audit_rows[0]["event"] == "sms_template_missing"
    assert cur.audit_rows[0]["metadata"] == {"status": "No Such Status"}
