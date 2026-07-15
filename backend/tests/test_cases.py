"""Tests for POST /api/v1/cases/submit (Story 2.4).

The DB is faked (no Postgres in CI): a FakeConn/FakeCursor implements just the SQL the
endpoint issues, so we exercise auth, validation, canonical-id assignment, the audit
write, and idempotency without a real database.
"""
import jwt
import pytest
from typing import Any

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _token(sub="officer-1"):
    return jwt.encode({"sub": sub}, SECRET, algorithm="HS256")


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
            self._result = (self.store["audit"][-1][5],) if self.store["audit"] else None
        elif "SELECT canonical_id FROM cases" in sql:
            oid = params[0]
            self._result = (self.store["cases"][oid],) if oid in self.store["cases"] else None
        elif "nextval" in sql:
            self.store["seq"] += 1
            self._result = (self.store["seq"],)
        elif "INSERT INTO cases" in sql:
            offline_id, canonical_id = params[0], params[1]
            self.store["cases"][offline_id] = canonical_id
            self.store["case_pk"] += 1
            # Capture the ownership columns so tests can assert them. Column order: offline_id,
            # canonical_id, damage_category, gps_lat, gps_lng, submitter_identity_hash, officer_id,
            # submitted_by_officer, citizen_id (Story 4.0).
            self.store["rows"][offline_id] = {
                "officer_id": params[6],
                "submitted_by_officer": params[7],
                "citizen_id": params[8],
                "district": params[9],
                "ds_division": params[10],
                "locale": params[11] if len(params) > 11 else "si",
            }
            self._result = (self.store["case_pk"],)
        elif "INSERT INTO audit_log" in sql:
            self.store["audit"].append(params)
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
    return {"cases": {}, "rows": {}, "seq": 0, "case_pk": 0, "audit": []}


def _officer_token(sub="officer-1", role="officer"):
    return jwt.encode(
        {"sub": sub, "user_metadata": {"role": role}}, SECRET, algorithm="HS256"
    )


@pytest.fixture
def estimate_spy(monkeypatch):
    """Story 5.2: isolate cases.py's behavioral tests from the real ML model while still
    letting tests assert exactly how estimate_and_store() was called."""
    calls = []

    def fake_estimate_and_store(cur, case_id, damage_category, ds_division_id, submitted_at,
                                 district=None, ai_severity=None):
        calls.append({
            "case_id": case_id, "damage_category": damage_category,
            "ds_division_id": ds_division_id, "district": district, "ai_severity": ai_severity,
        })
        return None

    monkeypatch.setattr("app.api.v1.cases.compensation.estimate_and_store", fake_estimate_and_store)
    return calls


@pytest.fixture
def client(monkeypatch, store, estimate_spy):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.cases._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _body(**overrides):
    body = {
        "offline_id": "11111111-1111-4111-8111-111111111111",
        "timestamp_local": "2026-06-30T10:00:00.000Z",
        "gps": {"lat": 7.29, "lng": 80.63},
        "damage_category": "crop",
        "submitter_identity_hash": "abc123",
    }
    body.update(overrides)
    return body


def test_submit_requires_bearer_token(client):
    res = client.post("/api/v1/cases/submit", json=_body())
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_submit_rejects_invalid_token(client):
    res = client.post(
        "/api/v1/cases/submit", json=_body(), headers={"Authorization": "Bearer not-a-jwt"}
    )
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_submit_requires_offline_id(client):
    body = _body()
    del body["offline_id"]
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "offline_id_required"


def test_submit_requires_damage_category(client):
    body = _body()
    del body["damage_category"]
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "damage_category_required"


def test_submit_rejects_wrong_type_damage_category(client, store):
    # Code review fix: a non-empty non-string (e.g. a JSON list) passed the old
    # truthiness-only check and reached compensation._map_damage_category()'s
    # dict.get() unguarded, raising an uncaught TypeError outside estimate_and_store's
    # own try/except (500 instead of this endpoint's normal {"error": ...} 400 contract).
    body = _body(damage_category=["crop"])
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_damage_category"
    assert len(store["cases"]) == 0


def test_submit_creates_case_with_canonical_id(client, store):
    res = client.post(
        "/api/v1/cases/submit", json=_body(), headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 201
    data = res.get_json()
    assert data["canonical_id"] == "HEC-2026-0001"
    assert data["offline_id"] == _body()["offline_id"]
    # audit row written with the JWT subject as actor
    assert len(store["audit"]) == 1
    assert store["audit"][0][1] == "submitted"
    assert store["audit"][0][2] == "officer-1"


def test_submit_500_when_secret_missing(monkeypatch, store):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": None})
    monkeypatch.setattr("app.api.v1.cases._get_connection", lambda: FakeConn(store))
    res = app.test_client().post(
        "/api/v1/cases/submit", json=_body(), headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


def test_submit_handles_malformed_gps(client):
    res = client.post(
        "/api/v1/cases/submit",
        json=_body(gps="not-a-dict"),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201  # gps coerced to {} → null lat/lng, no 500


def test_submit_handles_non_string_timestamp(client):
    res = client.post(
        "/api/v1/cases/submit",
        json=_body(timestamp_local=12345),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201  # falls back to current UTC year, no 500
    assert res.get_json()["canonical_id"].startswith("HEC-")


def test_submit_is_idempotent(client, store):
    headers = {"Authorization": f"Bearer {_token()}"}
    first = client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    second = client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.get_json()["canonical_id"] == second.get_json()["canonical_id"]
    # only one case + one audit row despite two submissions
    assert len(store["cases"]) == 1
    assert len(store["audit"]) == 1


# --- Story 3.5: officer-assisted submission -------------------------------------------------


def test_citizen_path_persists_officer_id_null(client, store):
    # No submitted_by_officer flag → citizen path unchanged; officer columns stay empty.
    res = client.post(
        "/api/v1/cases/submit", json=_body(), headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 201
    row = store["rows"][_body()["offline_id"]]
    assert row["officer_id"] is None
    assert row["submitted_by_officer"] is False


def test_officer_assisted_happy_path_persists_officer_columns(client, store):
    body = _body(submitted_by_officer=True, officer_id="officer-1")
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_officer_token()}"}
    )
    assert res.status_code == 201
    assert res.get_json()["canonical_id"] == "HEC-2026-0001"
    row = store["rows"][body["offline_id"]]
    assert row["officer_id"] == "officer-1"
    assert row["submitted_by_officer"] is True
    # audit actor is still the JWT subject
    assert store["audit"][0][2] == "officer-1"


def test_officer_id_mismatch_is_rejected_403_no_insert(client, store):
    # officer_id in the body does not match the JWT sub → 403, nothing inserted.
    body = _body(submitted_by_officer=True, officer_id="someone-else")
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_officer_token(sub='officer-1')}"}
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"
    assert store["cases"] == {}
    assert store["audit"] == []


def test_non_officer_role_with_officer_flag_is_rejected_403_no_insert(client, store):
    # A validly-signed token WITHOUT the officer role cannot use the officer-assisted path.
    body = _body(submitted_by_officer=True, officer_id="officer-1")
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_officer_token(sub='officer-1', role='citizen')}"}
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"
    assert store["cases"] == {}
    assert store["audit"] == []


def test_officer_token_missing_sub_is_rejected_403_no_insert(client, store):
    # A validly-signed officer token that OMITS `sub` entirely decodes fine (PyJWT only rejects
    # an explicit non-string `sub`, not a missing one) — claims.get("sub") is None. Paired with a
    # body that also omits officer_id, the two falsy values must NOT compare equal-and-pass (P4).
    token = jwt.encode({"user_metadata": {"role": "officer"}}, SECRET, algorithm="HS256")
    body = _body(submitted_by_officer=True)
    body.pop("officer_id", None)
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"
    assert store["cases"] == {}
    assert store["audit"] == []


def test_officer_assisted_is_idempotent(client, store):
    body = _body(submitted_by_officer=True, officer_id="officer-1")
    headers = {"Authorization": f"Bearer {_officer_token()}"}
    first = client.post("/api/v1/cases/submit", json=body, headers=headers)
    second = client.post("/api/v1/cases/submit", json=body, headers=headers)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.get_json()["canonical_id"] == second.get_json()["canonical_id"]
    assert len(store["cases"]) == 1
    assert len(store["audit"]) == 1


# --- Story 4.0: citizen ownership -----------------------------------------------------------


def test_authenticated_citizen_submit_stamps_citizen_id(client, store):
    # A plain authenticated user (JWT with sub, no staff role) → the case is owned by their UID.
    res = client.post(
        "/api/v1/cases/submit",
        json=_body(),
        headers={"Authorization": f"Bearer {jwt.encode({'sub': 'citizen-9'}, SECRET, algorithm='HS256')}"},
    )
    assert res.status_code == 201
    row = store["rows"][_body()["offline_id"]]
    assert row["citizen_id"] == "citizen-9"
    assert row["officer_id"] is None
    assert row["submitted_by_officer"] is False


def test_officer_token_without_assist_flag_leaves_citizen_id_null(client, store):
    # A staff (officer) token that is NOT using the officer-assisted flag is not a citizen —
    # citizen_id stays NULL (staff cases aren't owned via the citizen leg).
    res = client.post(
        "/api/v1/cases/submit",
        json=_body(),
        headers={"Authorization": f"Bearer {_officer_token(sub='officer-7')}"},
    )
    assert res.status_code == 201
    row = store["rows"][_body()["offline_id"]]
    assert row["citizen_id"] is None
    assert row["officer_id"] is None  # not officer-assisted → officer_id also null


# --- Story 5.2: compensation estimation wired into the submit path --------------------------


def test_submit_triggers_compensation_estimate(client, store, estimate_spy):
    res = client.post(
        "/api/v1/cases/submit", json=_body(),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    assert len(estimate_spy) == 1
    assert estimate_spy[0]["damage_category"] == "crop"
    assert estimate_spy[0]["district"] is None


def test_submit_retry_does_not_re_trigger_compensation_estimate(client, store, estimate_spy):
    headers = {"Authorization": f"Bearer {_token()}"}
    client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    assert len(estimate_spy) == 1


def test_submit_with_district_and_severity_persists_and_forwards(client, store, estimate_spy):
    body = _body(district="අනුරාධපුරය", ds_division="ඉපලෝගම", ai_severity="Moderate")
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["district"] == "අනුරාධපුරය"
    assert row["ds_division"] == "ඉපලෝගම"
    assert estimate_spy[0]["district"] == "අනුරාධපුරය"
    assert estimate_spy[0]["ds_division_id"] == "ඉපලෝගම"
    assert estimate_spy[0]["ai_severity"] == "Moderate"


def test_submit_wrong_type_district_is_ignored_not_500(client, store, estimate_spy):
    body = _body(district=999, ai_severity={"x": 1})
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ai_severity"] is None


def test_submit_empty_string_district_stored_as_none_not_empty_string(client, store, estimate_spy):
    # Code review fix: "" used to pass the isinstance(str) guard unmodified, so
    # cases.district ended up storing '' instead of NULL, and estimate_and_store
    # received "" instead of None.
    body = _body(district="", ds_division="", ai_severity="")
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["district"] is None
    assert row["ds_division"] is None
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ds_division_id"] is None
    assert estimate_spy[0]["ai_severity"] is None


def test_submit_saves_locale(client, store):
    body = _body(locale="ta")
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["locale"] == "ta"
