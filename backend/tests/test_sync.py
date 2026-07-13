"""Tests for POST /api/v1/sync/batch (Story 4.2).

The DB is faked (no Postgres in CI): a FakeConn/FakeCursor implements just the SQL the
endpoint issues (mirrors test_cases.py's pattern), so we exercise auth, batch validation,
idempotency, canonical-id assignment, the audit write, and the officer_id-from-JWT guard
without a real database.
"""
import json

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

        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        elif "SELECT id, canonical_id" in sql:
            oid = params[0]
            if oid in self.store["cases"]:
                row = self.store["rows"][oid]
                self._result = (
                    row["id"],
                    self.store["cases"][oid],
                    row["damage_category"],
                    row["gps_lat"],
                    row["gps_lng"],
                    row["submitter_identity_hash"],
                    row["officer_id"],
                )
            else:
                self._result = None
        elif "SELECT canonical_id FROM cases" in sql:
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
                district,
                ds_division,
            ) = params
            if offline_id == self.store.get("race_offline_id") and offline_id not in self.store["cases"]:
                # Simulate a concurrent winner committing between our fast-path SELECT
                # (which found nothing) and our own INSERT — our insert loses the race.
                winner = self.store["race_winner_row"]
                self.store["cases"][offline_id] = winner["canonical_id"]
                self.store["case_pk"] += 1
                self.store["rows"][offline_id] = {"id": self.store["case_pk"], **winner}
                self._result = None
            elif offline_id in self.store["cases"]:
                # ON CONFLICT DO NOTHING -> no row returned.
                self._result = None
            else:
                self.store["cases"][offline_id] = canonical_id
                self.store["case_pk"] += 1
                self.store["rows"][offline_id] = {
                    "id": self.store["case_pk"],
                    "damage_category": damage_category,
                    "gps_lat": gps_lat,
                    "gps_lng": gps_lng,
                    "submitter_identity_hash": submitter_identity_hash,
                    "officer_id": officer_id,
                    "submitted_by_officer": submitted_by_officer,
                    "district": district,
                    "ds_division": ds_division,
                }
                self._result = (self.store["case_pk"],)
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.store["audit"].append(
                {
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
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
    return {"cases": {}, "rows": {}, "seq": 0, "case_pk": 0, "audit": []}


@pytest.fixture
def estimate_spy(monkeypatch):
    """Story 5.2: isolate sync.py's behavioral tests from the real ML model (avoids
    coupling unrelated tests to RF inference latency/behavior) while still letting tests
    assert exactly how estimate_and_store() was called."""
    calls = []

    def fake_estimate_and_store(cur, case_id, damage_category, ds_division_id, submitted_at,
                                 district=None, ai_severity=None):
        calls.append({
            "case_id": case_id, "damage_category": damage_category,
            "ds_division_id": ds_division_id, "district": district, "ai_severity": ai_severity,
        })
        return None

    monkeypatch.setattr("app.api.v1.sync.compensation.estimate_and_store", fake_estimate_and_store)
    return calls


@pytest.fixture
def client(monkeypatch, store, estimate_spy):
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


# --- Story 4.3: log-only UUID-collision detection ---


def test_matching_retry_does_not_log_collision(client, store):
    offline_id = "55555555-5555-4555-8555-555555555555"
    payload = _item(offline_id)
    res1 = client.post(
        "/api/v1/sync/batch", json={"cases": [payload]}, headers=_auth(_officer_token())
    )
    assert res1.status_code == 200

    # Identical retry (byte-for-byte, as the real client would replay it).
    res2 = client.post(
        "/api/v1/sync/batch", json={"cases": [payload]}, headers=_auth(_officer_token())
    )
    assert res2.status_code == 200
    assert res2.get_json()["results"][0]["inserted"] is False
    assert not any(a["event"] == "uuid_collision" for a in store["audit"])


def test_differing_content_on_existing_offline_id_logs_collision(client, store):
    offline_id = "66666666-6666-4666-8666-666666666666"
    first = _item(offline_id, damage_category="crop")
    res1 = client.post(
        "/api/v1/sync/batch", json={"cases": [first]}, headers=_auth(_officer_token())
    )
    assert res1.status_code == 200
    first_canonical_id = res1.get_json()["results"][0]["canonical_id"]

    # Same offline_id, different content — simulates a true UUID collision from another device.
    second = _item(offline_id, damage_category="property")
    res2 = client.post(
        "/api/v1/sync/batch", json={"cases": [second]}, headers=_auth(_officer_token())
    )
    assert res2.status_code == 200
    result = res2.get_json()["results"][0]
    # No data is lost: the original stored case still wins, unchanged.
    assert result["inserted"] is False
    assert result["canonical_id"] == first_canonical_id
    assert store["rows"][offline_id]["damage_category"] == "crop"

    collisions = [a for a in store["audit"] if a["event"] == "uuid_collision"]
    assert len(collisions) == 1
    assert collisions[0]["metadata"]["offline_id"] == offline_id


def test_lost_race_branch_also_logs_collision_when_content_differs(client, store):
    """The 'lost the race' branch (two concurrent requests for the same offline_id; ours
    loses the ON CONFLICT race) is the genuine concurrent-collision scenario the feature
    exists for — it must not bypass collision detection."""
    offline_id = "77777777-7777-4777-8777-777777777777"
    store["race_offline_id"] = offline_id
    store["race_winner_row"] = {
        "canonical_id": "HEC-2026-9001",
        "damage_category": "property",
        "gps_lat": 6.0,
        "gps_lng": 79.0,
        "submitter_identity_hash": "other-hash",
        "officer_id": None,
    }
    item = _item(offline_id, damage_category="crop")  # differs from the winner's "property"

    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )

    assert res.status_code == 200
    result = res.get_json()["results"][0]
    assert result["inserted"] is False
    assert result["canonical_id"] == "HEC-2026-9001"

    collisions = [a for a in store["audit"] if a["event"] == "uuid_collision"]
    assert len(collisions) == 1


# --- Story 5.2: compensation estimation wired into the sync path ---


def test_batch_insert_triggers_compensation_estimate(client, store, estimate_spy):
    item = _item("11111111-1111-4111-8111-111111111111")
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    assert len(estimate_spy) == 1
    assert estimate_spy[0]["damage_category"] == "crop"
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ai_severity"] is None


def test_batch_retry_does_not_re_trigger_compensation_estimate(client, store, estimate_spy):
    item = _item("11111111-1111-4111-8111-111111111111")
    client.post("/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token()))
    client.post("/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token()))
    # The fast-path (already-synced) branch returns before estimate_and_store() would run.
    assert len(estimate_spy) == 1


def test_batch_item_with_district_and_severity_persists_and_forwards(client, store, estimate_spy):
    item = _item(
        "11111111-1111-4111-8111-111111111111",
        district="අනුරාධපුරය",
        ds_division="ඉපලෝගම",
        ai_severity="Severe",
    )
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    stored = store["rows"][item["offline_id"]]
    assert stored["district"] == "අනුරාධපුරය"
    assert stored["ds_division"] == "ඉපලෝගම"
    assert estimate_spy[0]["district"] == "අනුරාධපුරය"
    assert estimate_spy[0]["ds_division_id"] == "ඉපලෝගම"
    assert estimate_spy[0]["ai_severity"] == "Severe"


def test_batch_item_wrong_type_district_is_ignored_not_500(client, store, estimate_spy):
    bad = _item("11111111-1111-4111-8111-111111111111", district=12345, ai_severity=["Severe"])
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [bad]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ai_severity"] is None


def test_batch_item_empty_string_district_stored_as_none_not_empty_string(client, store, estimate_spy):
    item = _item(
        "11111111-1111-4111-8111-111111111111", district="", ds_division="", ai_severity="",
    )
    res = client.post(
        "/api/v1/sync/batch", json={"cases": [item]}, headers=_auth(_officer_token())
    )
    assert res.status_code == 200
    stored = store["rows"][item["offline_id"]]
    assert stored["district"] is None
    assert stored["ds_division"] is None
    assert estimate_spy[0]["district"] is None
    assert estimate_spy[0]["ds_division_id"] is None
    assert estimate_spy[0]["ai_severity"] is None
