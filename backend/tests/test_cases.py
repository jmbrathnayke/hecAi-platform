"""Tests for POST /api/v1/cases/submit (Story 2.4).

The DB is faked (no Postgres in CI): a FakeConn/FakeCursor implements just the SQL the
endpoint issues, so we exercise auth, validation, canonical-id assignment, the audit
write, and idempotency without a real database.
"""
import jwt
import pytest

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

    def execute(self, sql, params=()):
        if "SELECT canonical_id FROM cases" in sql:
            oid = params[0]
            self._result = (self.store["cases"][oid],) if oid in self.store["cases"] else None
        elif "nextval" in sql:
            self.store["seq"] += 1
            self._result = (self.store["seq"],)
        elif "INSERT INTO cases" in sql:
            offline_id, canonical_id = params[0], params[1]
            self.store["cases"][offline_id] = canonical_id
            self.store["case_pk"] += 1
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
    return {"cases": {}, "seq": 0, "case_pk": 0, "audit": []}


@pytest.fixture
def client(monkeypatch, store):
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
