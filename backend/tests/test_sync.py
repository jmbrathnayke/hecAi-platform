"""Tests for POST /api/v1/sync/batch (Story 4.2).

The DB is faked (no Postgres in CI): a FakeConn/FakeCursor implements just the SQL the
endpoint issues (mirrors test_cases.py's pattern), so we exercise auth, batch validation,
idempotency, canonical-id assignment, the audit write, and the officer_id-from-JWT guard
without a real database.
"""
import jwt
import psycopg2
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _officer_token(sub="officer-1", role="officer"):
    return jwt.encode({"sub": sub, "user_metadata": {"role": role}}, SECRET, algorithm="HS256")


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if "INSERT INTO cases" in sql and params[0] == self.store.get("fail_offline_id"):
            raise psycopg2.OperationalError("simulated DB failure")

        if "SELECT canonical_id FROM cases" in sql:
            oid = params[0]
            self._result = (self.store["cases"][oid],) if oid in self.store["cases"] else None
        elif "nextval" in sql:
            self.store["seq"] += 1
            self._result = (self.store["seq"],)
        elif "INSERT INTO cases" in sql:
            (
                offline_id,
                canonical_id,
                damage_category,
                gps_lat,
                gps_lng,
                submitter_identity_hash,
                officer_id,
                submitted_by_officer,
            ) = params
            if offline_id in self.store["cases"]:
                # ON CONFLICT DO NOTHING -> no row returned.
                self._result = None
            else:
                self.store["cases"][offline_id] = canonical_id
                self.store["case_pk"] += 1
                self.store["rows"][offline_id] = {
                    "damage_category": damage_category,
                    "gps_lat": gps_lat,
                    "gps_lng": gps_lng,
                    "officer_id": officer_id,
                    "submitted_by_officer": submitted_by_officer,
                }
                self._result = (self.store["case_pk"],)
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id = params
            self.store["audit"].append({"case_id": case_id, "event": event, "actor_id": actor_id})
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


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.sync._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _item(offline_id, **overrides):
    item = {
        "offline_id": offline_id,
        "timestamp_local": "2026-07-08T10:00:00.000Z",
        "gps": {"lat": 7.29, "lng": 80.63},
        "damage_category": "crop",
        "submitter_identity_hash": "abc123",
    }
    item.update(overrides)
    return item


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_batch_inserts_new_cases(client, store):
    items = [_item(f"11111111-1111-4111-8111-11111111111{i}") for i in range(3)]
    res = client.post(
        "/api/v1/sync/batch", json={"cases": items}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["results"]) == 3
    assert all(r["inserted"] for r in data["results"])
    assert len(store["cases"]) == 3
    assert len(store["audit"]) == 3
    assert all(a["event"] == "case_synced" for a in store["audit"])


def test_batch_idempotent_on_retry(client, store):
    items = [_item(f"11111111-1111-4111-8111-11111111111{i}") for i in range(3)]
    res1 = client.post(
        "/api/v1/sync/batch", json={"cases": items}, headers=_auth(_officer_token())
    )
    first_ids = {r["offline_id"]: r["canonical_id"] for r in res1.get_json()["results"]}
    seq_after_first = store["seq"]

    res2 = client.post(
        "/api/v1/sync/batch", json={"cases": items}, headers=_auth(_officer_token())
    )
    assert res2.status_code == 200
    data2 = res2.get_json()
    assert len(data2["results"]) == 3
    assert all(r["inserted"] is False for r in data2["results"])
    for r in data2["results"]:
        assert r["canonical_id"] == first_ids[r["offline_id"]]
    assert store["seq"] == seq_after_first  # no new sequence values burned
    assert len(store["audit"]) == 3  # no new audit rows on retry


def test_batch_mixed_new_and_existing(client, store):
    existing = [_item(f"22222222-2222-4222-8222-22222222222{i}") for i in range(3)]
    client.post(
        "/api/v1/sync/batch", json={"cases": existing}, headers=_auth(_officer_token())
    )
    new_items = [_item(f"33333333-3333-4333-8333-33333333333{i}") for i in range(7)]
    batch = existing + new_items
    res = client.post(
        "/api/v1/sync/batch", json={"cases": batch}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["results"]) == 10
    inserted = [r for r in data["results"] if r["inserted"]]
    skipped = [r for r in data["results"] if not r["inserted"]]
    assert len(inserted) == 7
    assert len(skipped) == 3
    offline_ids_in_response = {r["offline_id"] for r in data["results"]}
    assert offline_ids_in_response == {item["offline_id"] for item in batch}


def test_batch_requires_bearer_token(client):
    res = client.post("/api/v1/sync/batch", json={"cases": [_item("a")]})
    assert res.status_code == 401


def test_batch_rejects_non_officer_role(client):
    token = _officer_token(role="citizen")
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [_item("a")]}, headers=_auth(token)
    )
    assert res.status_code == 403


def test_batch_malformed_missing_offline_id(client, store):
    bad = _item("")
    bad.pop("offline_id")
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_malformed_missing_damage_category(client, store):
    bad = _item("11111111-1111-4111-8111-111111111111")
    bad.pop("damage_category")
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_size_cap(client, store):
    items = [_item(f"44444444-4444-4444-8444-4444444444{i:02d}") for i in range(51)]
    res = client.post(
        "/api/v1/sync/batch", json={"cases": items}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_empty(client):
    res = client.post(
        "/api/v1/sync/batch", json={"cases": []}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400


def test_officer_assisted_item_uses_verified_officer_id(client, store):
    item = _item(
        "11111111-1111-4111-8111-111111111111",
        submitted_by_officer=True,
        officer_id="someone-else",
    )
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token(sub="officer-1"))
    )
    assert res.status_code == 200
    stored = store["rows"][item["offline_id"]]
    assert stored["officer_id"] == "officer-1"
    assert stored["submitted_by_officer"] is True


# --- Review-patch coverage: type/range validation, malformed year, unhandled DB error ---


def test_batch_rejects_wrong_type_offline_id(client, store):
    bad = _item(12345)  # int instead of str
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_rejects_wrong_type_damage_category(client, store):
    bad = _item("11111111-1111-4111-8111-111111111111", damage_category=["crop"])
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_rejects_out_of_range_gps(client, store):
    bad = _item("11111111-1111-4111-8111-111111111111", gps={"lat": 923456.1, "lng": 80.63})
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_rejects_wrong_type_gps_value(client, store):
    bad = _item("11111111-1111-4111-8111-111111111111", gps={"lat": "north", "lng": 80.63})
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_rejects_bool_as_gps_value(client, store):
    bad = _item("11111111-1111-4111-8111-111111111111", gps={"lat": True, "lng": 80.63})
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 400
    assert len(store["cases"]) == 0


def test_batch_accepts_null_gps(client, store):
    ok = _item("11111111-1111-4111-8111-111111111111", gps=None)
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [ok]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200


def test_malformed_timestamp_falls_back_to_current_year(client, store):
    # "99" would pass a bare isdigit() check but is not a valid 4-digit year.
    item = _item("11111111-1111-4111-8111-111111111111", timestamp_local="99")
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    canonical_id = res.get_json()["results"][0]["canonical_id"]
    current_year = str(__import__("datetime").datetime.now(__import__("datetime").timezone.utc).year)
    assert canonical_id.startswith(f"HEC-{current_year}-")


def test_unhandled_db_error_returns_json_500(client, store):
    store["fail_offline_id"] = "22222222-2222-4222-8222-222222222222"
    item = _item(store["fail_offline_id"])
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_error"
