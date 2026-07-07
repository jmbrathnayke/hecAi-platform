"""Tests for POST /api/v1/inference/log (Story 3.4).

The DB is faked (no Postgres in CI): a FakeConn/FakeCursor implements just the SQL the endpoint
issues (resolve case_id from offline_id, insert one inference_log row), so we exercise auth
(require_officer — first real consumer), body validation, and the recorded row shape without a
real database. JWTs carry user_metadata.role="officer" because require_officer() checks the role.
"""
import json

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _token(sub="officer-1", role="officer"):
    claims = {"sub": sub, "user_metadata": {"role": role, "assigned_divisions": ["DIV-1"]}}
    return jwt.encode(claims, SECRET, algorithm="HS256")


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if "SELECT id FROM cases" in sql:
            oid = params[0]
            self._result = (self.store["cases"][oid],) if oid in self.store["cases"] else None
        elif "INSERT INTO inference_log" in sql:
            # Column order matches the endpoint's INSERT.
            (
                case_id,
                model_type,
                model_version,
                input_features,
                prediction,
                confidence,
                was_overridden,
                override_reason,
                override_category,
            ) = params
            self.store["inference"].append(
                {
                    "case_id": case_id,
                    "model_type": model_type,
                    "model_version": model_version,
                    "input_features": json.loads(input_features),
                    "prediction": prediction,
                    "confidence": confidence,
                    "was_overridden": was_overridden,
                    "override_reason": override_reason,
                    "override_category": override_category,
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
    # Seed one already-synced case so case_id resolution has something to find.
    return {"cases": {"11111111-1111-4111-8111-111111111111": 7}, "inference": []}


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.inference._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _body(**overrides):
    body = {
        "offline_id": "11111111-1111-4111-8111-111111111111",
        "model_type": "mobilenetv2",
        "model_version": "mobilenetv2-v1",
        "prediction": "property_damage",
        "confidence": 0.89,
        "ai_severity": "Severe",
        "ai_processing_time_ms": 300,
        "was_overridden": True,
        "override_reason": "paddy field flooded, not a structure",
        "override_category": "crop_damage",
    }
    body.update(overrides)
    return body


def _auth():
    return {"Authorization": f"Bearer {_token()}"}


# --- happy paths -----------------------------------------------------------

def test_override_row_is_logged_201(client, store):
    res = client.post("/api/v1/inference/log", json=_body(), headers=_auth())
    assert res.status_code == 201
    assert res.get_json() == {"logged": True}

    assert len(store["inference"]) == 1
    row = store["inference"][0]
    assert row["case_id"] == 7  # resolved from offline_id
    assert row["model_type"] == "mobilenetv2"
    assert row["model_version"] == "mobilenetv2-v1"
    assert row["prediction"] == "property_damage"  # AI's ORIGINAL prediction preserved
    assert float(row["confidence"]) == 0.89
    assert row["was_overridden"] is True
    assert row["override_reason"] == "paddy field flooded, not a structure"
    assert row["override_category"] == "crop_damage"
    # officer_id comes from the JWT, recorded in input_features (never a body field).
    assert row["input_features"]["officer_id"] == "officer-1"
    assert row["input_features"]["offline_id"] == _body()["offline_id"]
    assert row["input_features"]["ai_severity"] == "Severe"


def test_non_override_row_is_logged_with_false(client, store):
    res = client.post(
        "/api/v1/inference/log",
        json=_body(was_overridden=False, override_reason=None, override_category=None),
        headers=_auth(),
    )
    assert res.status_code == 201
    row = store["inference"][0]
    assert row["was_overridden"] is False
    assert row["override_reason"] is None
    assert row["override_category"] is None


def test_officer_id_from_token_not_body(client, store):
    # A spoofed officer_id in the body must be ignored — only the JWT sub is recorded.
    res = client.post(
        "/api/v1/inference/log",
        json=_body(officer_id="attacker"),
        headers={"Authorization": f"Bearer {_token(sub='officer-real')}"},
    )
    assert res.status_code == 201
    assert store["inference"][0]["input_features"]["officer_id"] == "officer-real"


def test_case_id_null_when_offline_id_unknown(client, store):
    res = client.post(
        "/api/v1/inference/log",
        json=_body(offline_id="22222222-2222-4222-8222-222222222222"),
        headers=_auth(),
    )
    assert res.status_code == 201
    assert store["inference"][0]["case_id"] is None


# --- auth (AC7) ------------------------------------------------------------

def test_missing_token_returns_401(client):
    res = client.post("/api/v1/inference/log", json=_body())
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_non_officer_role_returns_403(client, store):
    res = client.post(
        "/api/v1/inference/log",
        json=_body(),
        headers={"Authorization": f"Bearer {_token(role='citizen')}"},
    )
    assert res.status_code == 403
    assert len(store["inference"]) == 0  # never inserts


# --- validation (AC7) ------------------------------------------------------

def test_override_reason_too_short_returns_400(client, store):
    res = client.post(
        "/api/v1/inference/log",
        json=_body(override_reason="short"),  # 5 chars
        headers=_auth(),
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "override_reason_too_short"
    assert len(store["inference"]) == 0


def test_out_of_vocab_override_category_returns_400(client, store):
    res = client.post(
        "/api/v1/inference/log",
        json=_body(override_category="combined"),  # derived rollup, not selectable
        headers=_auth(),
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_override_category"
    assert len(store["inference"]) == 0


def test_missing_prediction_returns_400(client):
    body = _body()
    del body["prediction"]
    res = client.post("/api/v1/inference/log", json=body, headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "prediction_required"


def test_missing_offline_id_returns_400(client):
    body = _body()
    del body["offline_id"]
    res = client.post("/api/v1/inference/log", json=body, headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "offline_id_required"


def test_non_object_body_returns_400(client):
    # A truthy non-object body (e.g. a JSON array) must be a 400, not a raw 500.
    res = client.post("/api/v1/inference/log", json=[1, 2], headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_body"


def test_malformed_offline_id_returns_400(client, store):
    res = client.post(
        "/api/v1/inference/log", json=_body(offline_id="not-a-uuid"), headers=_auth()
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_offline_id"
    assert len(store["inference"]) == 0


def test_out_of_range_confidence_returns_400(client, store):
    # 89.5 (a percentage) overflows DECIMAL(5,4); must be rejected as a client error.
    res = client.post("/api/v1/inference/log", json=_body(confidence=89.5), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_confidence"
    assert len(store["inference"]) == 0


def test_non_bool_was_overridden_returns_400(client, store):
    # The string "false" is truthy — must not silently flip into the override branch.
    res = client.post(
        "/api/v1/inference/log", json=_body(was_overridden="false"), headers=_auth()
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_was_overridden"
    assert len(store["inference"]) == 0


def test_overlong_prediction_returns_400(client, store):
    res = client.post(
        "/api/v1/inference/log", json=_body(prediction="x" * 51), headers=_auth()
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_prediction"
    assert len(store["inference"]) == 0


def test_same_category_override_recorded_as_non_override(client, store):
    # D1: officer "overrides" to the class the AI already predicted → not a disagreement, so
    # was_overridden is recorded False (metric stays honest) but the reason is kept as a note.
    res = client.post(
        "/api/v1/inference/log",
        json=_body(override_category="property_damage"),  # == prediction
        headers=_auth(),
    )
    assert res.status_code == 201
    row = store["inference"][0]
    assert row["was_overridden"] is False
    assert row["override_category"] == "property_damage"
    assert row["override_reason"] == "paddy field flooded, not a structure"


# --- AC5: override-rate metric shape --------------------------------------

def test_override_rate_is_computable_from_inference_log_alone(client, store):
    # Two mobilenetv2 rows: one override, one not → the AC5 query yields 0.5. This asserts the
    # data SHAPE supports (rows WHERE was_overridden) / (total for mobilenetv2); the dashboard
    # itself is Story 6.1.
    client.post("/api/v1/inference/log", json=_body(), headers=_auth())  # overridden
    client.post(
        "/api/v1/inference/log",
        json=_body(
            offline_id="22222222-2222-4222-8222-222222222222",
            was_overridden=False,
            override_reason=None,
            override_category=None,
        ),
        headers=_auth(),
    )
    rows = [r for r in store["inference"] if r["model_type"] == "mobilenetv2"]
    override_rate = sum(1 for r in rows if r["was_overridden"]) / len(rows)
    assert override_rate == 0.5
