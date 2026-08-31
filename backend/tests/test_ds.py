"""Tests for the Divisional Secretariat API (Story 8.5).

Two things these have to prove beyond "it returns rows":
  1. a DS officer sees ONE division — not a district, not another division;
  2. adding this fourth role did not widen or narrow `officer` or `admin` (Epic 7 regression).
"""
import json
from datetime import datetime

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256

THALAWA = "තලාව"
KEKIRAWA = "කැකිරාව"


def _token(sub="ds-1", role="ds_officer", division=THALAWA):
    meta = {}
    if role is not None:
        meta["role"] = role
    if division is not None:
        meta["ds_division"] = division
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _case(canonical, division, status="Submitted", household_ref="HH-2026-0001"):
    return {
        "canonical_id": canonical,
        "offline_id": f"uuid-{canonical}",
        "status": status,
        "damage_category": "crop",
        "submitted_via": "app",
        "submitted_at": datetime(2026, 8, 20, 9, 0),
        "updated_at": datetime(2026, 8, 20, 9, 0),
        "approved_amount": None,
        "ds_division_id": division,
        "household_ref": household_ref,
        # PII that must never appear in a response:
        "citizen_nic_plain": "200012345678",
        "submitter_identity_hash": "deadbeef",
    }


_PROJECTION = (
    "canonical_id", "offline_id", "status", "damage_category", "submitted_via",
    "submitted_at", "updated_at", "approved_amount", "household_ref",
)


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._rows = []
        self._one = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif "SELECT hash FROM audit_log" in s:
            rows = self.store["audit"]
            self._one = (rows[-1]["hash"],) if rows else None
        elif s.startswith("INSERT INTO audit_log"):
            self.store["audit"].append(
                {"case_id": params[0], "event": params[1], "actor_id": params[2],
                 "metadata": params[3], "hash": params[5]}
            )
            self._one = None
        elif "FROM cases c LEFT JOIN households h" in s:
            division, status_filter, _sf2, _limit = params
            rows = [c for c in self.store["cases"] if c["ds_division_id"] == division]
            if status_filter is not None:
                rows = [c for c in rows if c["status"] == status_filter]
            rows.sort(key=lambda c: c["submitted_at"], reverse=True)
            self._rows = [tuple(c[col] for col in _PROJECTION) for c in rows]
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one

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
            _case("HEC-2026-0001", THALAWA),
            _case("HEC-2026-0002", THALAWA, status="Approved"),
            _case("HEC-2026-0003", KEKIRAWA),  # another division's
        ],
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.ds._get_connection", lambda: FakeConn(store))
    return app.test_client()


# --------------------------------------------------------------------- scoping
def test_lists_only_this_officers_division(client):
    res = client.get("/api/v1/ds/cases", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    assert {c["canonical_id"] for c in body["cases"]} == {"HEC-2026-0001", "HEC-2026-0002"}
    assert body["count"] == 2
    assert body["ds_division"] == THALAWA


def test_a_different_division_sees_different_cases(client):
    res = client.get("/api/v1/ds/cases", headers=_auth(sub="ds-2", division=KEKIRAWA))
    assert {c["canonical_id"] for c in res.get_json()["cases"]} == {"HEC-2026-0003"}


def test_division_comes_from_the_token_not_the_query_string(client):
    """A division supplied by the client would let any DS officer read another division's cases —
    and later authorise payment on them."""
    res = client.get(f"/api/v1/ds/cases?ds_division={KEKIRAWA}", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["cases"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0002"}  # still Thalawa's


def test_status_filter_applies_within_the_division(client):
    res = client.get("/api/v1/ds/cases?status=Approved", headers=_auth())
    assert {c["canonical_id"] for c in res.get_json()["cases"]} == {"HEC-2026-0002"}


def test_household_reference_travels_with_each_case(client):
    res = client.get("/api/v1/ds/cases", headers=_auth())
    assert res.get_json()["cases"][0]["household_ref"] == "HH-2026-0001"


# --------------------------------------------------------------------- auth
def test_requires_a_token(client):
    assert client.get("/api/v1/ds/cases").status_code == 401


@pytest.mark.parametrize("role", ["officer", "admin", "system_admin", None])
def test_other_roles_are_refused(client, role):
    assert client.get("/api/v1/ds/cases", headers=_auth(role=role)).status_code == 403


def test_a_ds_officer_with_no_division_gets_an_explicit_403(client):
    """Not an empty list. `WHERE ds_division = NULL` matches zero rows and is indistinguishable
    from "your division has no cases" — the same trap admin.py fixed for district_id."""
    res = client.get("/api/v1/ds/cases", headers=_auth(division=None))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_division_assigned"


def test_a_blank_division_claim_is_also_refused(client):
    res = client.get("/api/v1/ds/cases", headers=_auth(division="   "))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_division_assigned"


def test_a_token_without_sub_is_rejected(client):
    token = jwt.encode(
        {"app_metadata": {"role": "ds_officer", "ds_division": THALAWA}}, SECRET,
        algorithm="HS256",
    )
    res = client.get("/api/v1/ds/cases", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


def test_the_role_is_not_read_from_client_writable_user_metadata(client):
    """user_metadata is writable by any citizen via auth.updateUser(). If it were trusted here,
    self-assigning ds_officer would expose another division's cases."""
    token = jwt.encode(
        {"sub": "citizen-x",
         "user_metadata": {"role": "ds_officer", "ds_division": THALAWA},
         "app_metadata": {}},
        SECRET, algorithm="HS256",
    )
    res = client.get("/api/v1/ds/cases", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 403


# --------------------------------------------------------------------- PII + audit
def test_response_carries_no_pii(client):
    blob = client.get("/api/v1/ds/cases", headers=_auth()).get_data(as_text=True)
    assert "200012345678" not in blob
    assert "deadbeef" not in blob
    assert "nic_hmac" not in blob


def test_a_read_is_audit_logged(client, store):
    client.get("/api/v1/ds/cases", headers=_auth())
    entry = store["audit"][-1]
    assert entry["event"] == "ds_officer_viewed_cases"
    assert entry["actor_id"] == "ds-1"
    assert entry["case_id"] is None  # not about a single case
    # write_audit_log serialises metadata before the INSERT, so the fake captures a string.
    metadata = json.loads(entry["metadata"])
    assert metadata["ds_division"] == THALAWA
    assert metadata["result_count"] == 2
