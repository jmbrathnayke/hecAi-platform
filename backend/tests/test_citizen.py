"""Tests for GET /api/v1/citizen/cases (Story 4.0, citizen "My Cases").

DB faked: a FakeConn/FakeCursor implements the single scoped SELECT the endpoint issues, so we
exercise require_citizen auth (401 no token, 403 staff), owner-scoping, and the PII-free payload
without a real database.
"""
from datetime import datetime

import jwt
import pytest
from typing import Any

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _token(sub="citizen-1", role=None):
    meta = {"role": role} if role is not None else {}
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _case(canonical, citizen_id, status="Submitted", when=None):
    return {
        "canonical_id": canonical,
        "offline_id": f"uuid-{canonical}",
        "status": status,
        "damage_category": "crop",
        "submitted_via": "app",
        "submitted_at": when or datetime(2026, 7, 8, 10, 0, 0),
        "updated_at": when or datetime(2026, 7, 8, 10, 0, 0),
        "citizen_id": citizen_id,
        # PII columns that must NEVER appear in the response:
        "citizen_nic_plain": "200012345678",
        "submitter_identity_hash": "deadbeef",
    }


_PROJECTION = (
    "canonical_id", "offline_id", "status", "damage_category",
    "submitted_via", "submitted_at", "updated_at",
)


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        if "FROM cases" in sql:
            citizen_id, _limit = params
            rows = [c for c in self.store["cases"] if c["citizen_id"] == citizen_id]
            rows.sort(key=lambda c: c["submitted_at"], reverse=True)
            self._rows = [tuple(c[col] for col in _PROJECTION) for c in rows]
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.store)

    def close(self):
        pass


@pytest.fixture
def store():
    return {
        "cases": [
            _case("HEC-2026-0001", "citizen-1", when=datetime(2026, 7, 8, 9, 0)),
            _case("HEC-2026-0002", "citizen-1", when=datetime(2026, 7, 8, 11, 0)),
            _case("HEC-2026-0003", "citizen-2"),  # someone else's
        ]
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.citizen._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def test_lists_only_my_cases(client):
    res = client.get("/api/v1/citizen/cases", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    ids = {c["canonical_id"] for c in body["cases"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0002"}  # not citizen-2's 0003
    assert body["count"] == 2
    # newest first
    assert body["cases"][0]["canonical_id"] == "HEC-2026-0002"


def test_other_citizens_cases_excluded(client):
    res = client.get("/api/v1/citizen/cases", headers=_auth(sub="citizen-2"))
    ids = {c["canonical_id"] for c in res.get_json()["cases"]}
    assert ids == {"HEC-2026-0003"}


def test_payload_has_no_pii(client):
    res = client.get("/api/v1/citizen/cases", headers=_auth())
    for c in res.get_json()["cases"]:
        assert "citizen_nic_plain" not in c
        assert "submitter_identity_hash" not in c
    assert set(res.get_json()["cases"][0].keys()) == set(_PROJECTION)


def test_empty_when_citizen_owns_nothing(client):
    res = client.get("/api/v1/citizen/cases", headers=_auth(sub="citizen-nobody"))
    assert res.status_code == 200
    assert res.get_json()["cases"] == []


def test_missing_token_401(client):
    res = client.get("/api/v1/citizen/cases")
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_staff_token_forbidden_403(client):
    # An officer/admin JWT is valid but is NOT a citizen — 403, never scoped as one.
    for role in ("officer", "admin"):
        res = client.get("/api/v1/citizen/cases", headers=_auth(role=role))
        assert res.status_code == 403
        assert res.get_json()["error"] == "forbidden"


def test_invalid_token_401(client):
    res = client.get("/api/v1/citizen/cases", headers={"Authorization": "Bearer not-a-jwt"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"
