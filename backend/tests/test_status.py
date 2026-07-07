"""Tests for GET /api/v1/cases/status/<reference> (Story 2.5).

Public, no-auth lookup. The DB is faked: a FakeConn/FakeCursor returns a canned row for
the SELECT the endpoint issues. We verify reference routing (UUID vs canonical), 404 on
miss, 400 on malformed input, that ONLY status metadata is returned (no PII — CRITICAL #1),
and that approved_amount appears only for Approved cases.
"""
from datetime import datetime, timezone

import psycopg2
import pytest

from app import create_app

UUID_REF = "11111111-1111-4111-8111-111111111111"
HEC_REF = "HEC-2026-0001"
UPDATED = datetime(2026, 6, 30, 10, 0, 0, tzinfo=timezone.utc)

# A full DB row mirrors the SELECT column order:
# (canonical_id, offline_id, status, updated_at, approved_amount)
PII_LEAK_GUARD = ("mobile", "submitter", "identity", "audit", "damage")


class FakeCursor:
    def __init__(self, row, captured):
        self.row = row
        self.captured = captured
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.captured["sql"] = sql
        self.captured["params"] = params
        self._result = self.row

    def fetchone(self):
        return self._result


class FakeConn:
    def __init__(self, row, captured):
        self.row = row
        self.captured = captured
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.row, self.captured)

    def close(self):
        self.closed = True


def make_client(monkeypatch, row):
    captured = {}
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})
    monkeypatch.setattr(
        "app.api.v1.status._get_connection", lambda: FakeConn(row, captured)
    )
    return app.test_client(), captured


def test_lookup_by_uuid_uses_offline_id(monkeypatch):
    row = (HEC_REF, UUID_REF, "Submitted", UPDATED, None)
    client, captured = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{UUID_REF}")
    assert res.status_code == 200
    assert "offline_id = %s" in captured["sql"]
    assert captured["params"] == (UUID_REF,)
    data = res.get_json()
    assert data["canonical_id"] == HEC_REF
    assert data["offline_id"] == UUID_REF
    assert data["status"] == "Submitted"
    assert data["updated_at"] == UPDATED.isoformat()


def test_lookup_by_canonical_uses_canonical_id(monkeypatch):
    row = (HEC_REF, UUID_REF, "Under Review", UPDATED, None)
    client, captured = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{HEC_REF}")
    assert res.status_code == 200
    assert "canonical_id = %s" in captured["sql"]
    assert captured["params"] == (HEC_REF,)


def test_lowercase_hec_is_uppercased_before_query(monkeypatch):
    # A lower/mixed-case HEC reference must be normalized to the stored uppercase form.
    row = (HEC_REF, UUID_REF, "Submitted", UPDATED, None)
    client, captured = make_client(monkeypatch, row)
    res = client.get("/api/v1/cases/status/hec-2026-0001")
    assert res.status_code == 200
    assert captured["params"] == (HEC_REF,)  # normalized, not the raw lowercase input


def test_trailing_newline_reference_is_rejected(monkeypatch):
    # fullmatch (not Python's `$`) must reject a trailing newline.
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})
    monkeypatch.setattr(
        "app.api.v1.status._get_connection",
        lambda: (_ for _ in ()).throw(AssertionError("should not query")),
    )
    res = app.test_client().get(f"/api/v1/cases/status/{UUID_REF}%0A")
    assert res.status_code == 400


def test_null_offline_id_serializes_as_null_not_string(monkeypatch):
    # HEC lookup of an online-created case with no offline_id must not return "None".
    row = (HEC_REF, None, "Submitted", UPDATED, None)
    client, _ = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{HEC_REF}")
    assert res.get_json()["offline_id"] is None


def test_db_error_returns_500_not_404(monkeypatch):
    # A DB failure must surface as a distinct 500, never a misleading 404.
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})

    def boom():
        raise psycopg2.OperationalError("connection refused")

    monkeypatch.setattr("app.api.v1.status._get_connection", boom)
    res = app.test_client().get(f"/api/v1/cases/status/{UUID_REF}")
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_error"


def test_not_found_returns_404(monkeypatch):
    client, _ = make_client(monkeypatch, None)
    res = client.get(f"/api/v1/cases/status/{UUID_REF}")
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_invalid_reference_returns_400_without_db(monkeypatch):
    # _get_connection should never be called for a malformed reference.
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})

    def boom():
        raise AssertionError("DB should not be touched for invalid input")

    monkeypatch.setattr("app.api.v1.status._get_connection", boom)
    res = app.test_client().get("/api/v1/cases/status/not-a-reference")
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_reference"


def test_v1_uuid_is_rejected(monkeypatch):
    # version digit '1' (not '4') must not match the strict UUID-v4 pattern.
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})
    monkeypatch.setattr(
        "app.api.v1.status._get_connection",
        lambda: (_ for _ in ()).throw(AssertionError("should not query")),
    )
    res = app.test_client().get(
        "/api/v1/cases/status/11111111-1111-1111-8111-111111111111"
    )
    assert res.status_code == 400


def test_response_excludes_pii(monkeypatch):
    row = (HEC_REF, UUID_REF, "Submitted", UPDATED, None)
    client, _ = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{UUID_REF}")
    keys = set(res.get_json().keys())
    assert keys == {"canonical_id", "offline_id", "status", "updated_at"}
    blob = res.get_data(as_text=True).lower()
    for forbidden in PII_LEAK_GUARD:
        assert forbidden not in blob


def test_approved_amount_present_only_when_approved(monkeypatch):
    row = (HEC_REF, UUID_REF, "Approved", UPDATED, 50000)
    client, _ = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{HEC_REF}")
    data = res.get_json()
    assert data["status"] == "Approved"
    assert data["approved_amount"] == 50000.0


def test_approved_amount_hidden_when_not_approved(monkeypatch):
    # Even if a stray amount exists in the row, it must not leak unless status is Approved.
    row = (HEC_REF, UUID_REF, "Rejected", UPDATED, 50000)
    client, _ = make_client(monkeypatch, row)
    res = client.get(f"/api/v1/cases/status/{HEC_REF}")
    assert "approved_amount" not in res.get_json()
