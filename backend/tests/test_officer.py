"""Tests for GET /api/v1/officer/cases (Story 3.7, officer dashboard case list).

DB faked (no Postgres): a FakeConn/FakeCursor implements the two statements the endpoint issues
(the scoped SELECT and the audit INSERT), so we exercise require_officer auth, the division/owner
scoping, the PII-free payload, the audit-on-view, and the status filter without a real database.
JWTs carry user_metadata.role="officer" because require_officer() checks role + assigned_divisions.
"""
from datetime import datetime

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _token(sub="officer-1", role="officer", divisions=("Kandy",)):
    claims = {"sub": sub, "user_metadata": {"role": role, "assigned_divisions": list(divisions)}}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _case(canonical, officer_id, division, status="Submitted", when=None):
    return {
        "canonical_id": canonical,
        "offline_id": f"uuid-{canonical}",
        "status": status,
        "damage_category": "crop",
        "submitted_via": "app",
        "gps_lat": 7.29,
        "gps_lng": 80.63,
        "submitted_at": when or datetime(2026, 7, 8, 10, 0, 0),
        "updated_at": when or datetime(2026, 7, 8, 10, 0, 0),
        "officer_id": officer_id,
        "ds_division_id": division,
        # PII columns that must NEVER appear in the response:
        "citizen_nic_plain": "200012345678",
        "submitter_identity_hash": "deadbeef",
    }


_PROJECTION = (
    "canonical_id", "offline_id", "status", "damage_category", "submitted_via",
    "gps_lat", "gps_lng", "submitted_at", "updated_at",
)


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if "FROM cases" in sql:
            officer_id, divisions, status_filter, _status2, _limit = params
            rows = []
            for c in self.store["cases"]:
                visible = c["officer_id"] == officer_id or (
                    c["ds_division_id"] is not None and c["ds_division_id"] in divisions
                )
                if not visible:
                    continue
                if status_filter is not None and c["status"] != status_filter:
                    continue
                rows.append(c)
            rows.sort(key=lambda c: c["submitted_at"], reverse=True)
            self._rows = [tuple(c[col] for col in _PROJECTION) for c in rows]
        elif "INSERT INTO audit_log" in sql:
            event, actor_id, metadata = params
            import json
            self.store["audit"].append(
                {"event": event, "actor_id": actor_id, "metadata": json.loads(metadata)}
            )
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
            _case("HEC-2026-0001", "officer-1", None, when=datetime(2026, 7, 8, 9, 0)),   # own
            _case("HEC-2026-0002", "other", "Kandy", when=datetime(2026, 7, 8, 11, 0)),   # my division
            _case("HEC-2026-0003", "other", "Colombo"),                                    # other division
            _case("HEC-2026-0004", "other", None),                                         # not mine at all
            _case("HEC-2026-0005", "officer-1", None, status="Approved"),                  # own, different status
        ],
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.officer._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


# --- happy path + scoping (AC2, AC4) --------------------------------------

def test_lists_only_in_scope_cases(client, store):
    res = client.get("/api/v1/officer/cases", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    ids = {c["canonical_id"] for c in body["cases"]}
    # own (0001, 0005) + my-division (0002); NOT other-division (0003) or unrelated (0004)
    assert ids == {"HEC-2026-0001", "HEC-2026-0002", "HEC-2026-0005"}
    assert body["count"] == 3
    # newest-first: 0002 (11:00) before 0001 (09:00)
    order = [c["canonical_id"] for c in body["cases"]]
    assert order.index("HEC-2026-0002") < order.index("HEC-2026-0001")


def test_out_of_scope_cases_never_returned(client):
    res = client.get("/api/v1/officer/cases", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["cases"]}
    assert "HEC-2026-0003" not in ids  # other division
    assert "HEC-2026-0004" not in ids  # other officer, no division


def test_payload_has_no_pii(client):
    res = client.get("/api/v1/officer/cases", headers=_auth())
    for c in res.get_json()["cases"]:
        assert "citizen_nic_plain" not in c
        assert "submitter_identity_hash" not in c
    # sanity: the operational fields are present
    first = res.get_json()["cases"][0]
    assert set(first.keys()) == set(_PROJECTION)


def test_empty_divisions_still_sees_own_cases(client):
    res = client.get("/api/v1/officer/cases", headers=_auth(divisions=()))
    ids = {c["canonical_id"] for c in res.get_json()["cases"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0005"}  # own cases via officer_id branch only


# --- status filter (AC8) ---------------------------------------------------

def test_status_filter(client):
    res = client.get("/api/v1/officer/cases?status=Approved", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["cases"]}
    assert ids == {"HEC-2026-0005"}


def test_unknown_status_yields_empty_not_error(client):
    res = client.get("/api/v1/officer/cases?status=Nonexistent", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["cases"] == []


# --- audit on view (AC5) ---------------------------------------------------

def test_view_is_audited_with_ip_and_count(client, store):
    client.get(
        "/api/v1/officer/cases",
        headers={**_auth(), "X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
    )
    assert len(store["audit"]) == 1
    row = store["audit"][0]
    assert row["event"] == "officer_viewed_cases"
    assert row["actor_id"] == "officer-1"
    assert row["metadata"]["ip_address"] == "203.0.113.9"  # first hop of X-Forwarded-For
    assert row["metadata"]["result_count"] == 3


# --- auth (AC2) ------------------------------------------------------------

def test_missing_token_401(client, store):
    res = client.get("/api/v1/officer/cases")
    assert res.status_code == 401
    assert store["audit"] == []  # never reached the handler


def test_non_officer_403(client, store):
    res = client.get("/api/v1/officer/cases", headers=_auth(role="citizen"))
    assert res.status_code == 403
    assert store["audit"] == []  # never inserts
