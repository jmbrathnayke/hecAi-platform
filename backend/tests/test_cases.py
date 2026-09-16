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

# Story 8.4: every submission now resolves a registered household, and the case inherits the
# household's district/division rather than taking them from the body (FR-10.6).
DISTRICT = "අනුරාධපුරය"
DIVISION = "තලාව"


def _household(hid, ref, uid=None, status="active"):
    return {"id": hid, "household_ref": ref, "district": DISTRICT,
            "ds_division": DIVISION, "status": status, "registrant_uid": uid}


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

    def _household(self, match):
        """Projects the 5-tuple registry.py selects: id, ref, district, ds_division, status."""
        hit = next((h for h in self.store["households"] if match(h)), None)
        return (
            hit["id"], hit["household_ref"], hit["district"], hit["ds_division"],
            hit["status"],
        ) if hit else None

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "FROM households WHERE registrant_uid" in sql:
            uid, status = params
            self._result = self._household(
                lambda h: h["registrant_uid"] == uid and h["status"] == status)
        elif "FROM households WHERE household_ref" in sql:
            ref, status = params
            self._result = self._household(
                lambda h: h["household_ref"] == ref and h["status"] == status)
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
                "household_id": params[12] if len(params) > 12 else None,
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
    return {
        "cases": {}, "rows": {}, "seq": 0, "case_pk": 0, "audit": [],
        # Registered households for the two subs these tests authenticate as. A test that
        # wants the unregistered path empties this list.
        "households": [
            _household(1, "HH-2026-0001", uid="officer-1"),
            _household(2, "HH-2026-0002", uid="officer-7"),
            _household(3, "HH-2026-0003", uid="citizen-9"),
        ],
    }


def _officer_token(sub="officer-1", role="officer"):
    return jwt.encode(
        {"sub": sub, "app_metadata": {"role": role}}, SECRET, algorithm="HS256"
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
        # Ignored on the citizen path (the household comes from the JWT); used on the
        # officer-assisted path, where the officer has looked the family up first.
        "household_ref": "HH-2026-0001",
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


def _events(store):
    """-> the event names written to the audit log, in order.

    Tests here used to assert on len(store["audit"]) as a proxy for "one submitted row". That
    stopped meaning what it said once submit_case gained the FR-6.4 staff alerts: with no VAPID
    keypair in the test config both alerts short-circuit and each records its own
    staff_push_skipped_not_configured row, so the count is 3 while the thing being asserted --
    exactly one submitted event -- is unchanged. Naming the event says what is meant and does not
    have to be revisited the next time a notification channel is added.
    """
    return [row[1] for row in store["audit"]]


def test_submit_creates_case_with_canonical_id(client, store):
    res = client.post(
        "/api/v1/cases/submit", json=_body(), headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 201
    data = res.get_json()
    assert data["canonical_id"] == "HEC-2026-0001"
    assert data["offline_id"] == _body()["offline_id"]
    # audit row written with the JWT subject as actor
    assert _events(store).count("submitted") == 1
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
    assert _events(store).count("submitted") == 1


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
    token = jwt.encode({"app_metadata": {"role": "officer"}}, SECRET, algorithm="HS256")
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
    assert _events(store).count("submitted") == 1


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


def test_officer_token_without_the_assist_flag_is_now_blocked(client, store):
    """BEHAVIOUR CHANGE, Story 8.4. This used to create a case with citizen_id NULL — an officer
    token that is neither a citizen nor using officer-assisted mode.

    Under FR-10.3 there is no household to attach such a case to, and a case with no household
    can never be paid: compensation goes to a registered family, not to a report. An officer who
    witnesses an incident should file it in officer-assisted mode against the affected family's
    household reference, which is the flow FR-1.2 describes.

    The officer's own household (officer-7 is registered above, as a private citizen) is
    deliberately NOT used: the case belongs to whoever suffered the damage, and silently
    attaching it to the officer's own family would misroute the compensation.
    """
    res = client.post(
        "/api/v1/cases/submit",
        json=_body(),
        headers={"Authorization": f"Bearer {_officer_token(sub='officer-7')}"},
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "not_registered"
    assert store["rows"] == {}


# --- Story 5.2: compensation estimation wired into the submit path --------------------------


def test_submit_triggers_compensation_estimate(client, store, estimate_spy):
    res = client.post(
        "/api/v1/cases/submit", json=_body(),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    assert len(estimate_spy) == 1
    assert estimate_spy[0]["damage_category"] == "crop"
    # Story 8.4: no longer None — the district now comes from the registered household.
    assert estimate_spy[0]["district"] == DISTRICT


def test_submit_retry_does_not_re_trigger_compensation_estimate(client, store, estimate_spy):
    headers = {"Authorization": f"Bearer {_token()}"}
    client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    assert len(estimate_spy) == 1


# --- Story 8.4: the case inherits its area from the household, never from the body ----------
#
# These three replace the Story 5.2 picker tests. Their subject changed rather than disappeared:
# the old ones asserted the body's district was stored, coerced and null-guarded. FR-10.6 makes
# the body's district irrelevant, so what has to be proven now is that it is IGNORED — including
# when it is a plausible-looking, valid-but-wrong value.


def test_case_inherits_district_and_division_from_the_household(client, store, estimate_spy):
    body = _body(ai_severity="Moderate")
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["district"] == DISTRICT
    assert row["ds_division"] == DIVISION
    assert row["household_id"] == 1
    assert estimate_spy[0]["district"] == DISTRICT
    assert estimate_spy[0]["ds_division_id"] == DIVISION
    assert estimate_spy[0]["ai_severity"] == "Moderate"


def test_a_district_supplied_in_the_body_is_ignored(client, store, estimate_spy):
    """The important one. A client sending a real-but-wrong division must not be able to route
    its own case away from the officers whose area the incident is actually in."""
    body = _body(district="අම්පාර", ds_division="ඉපලෝගම")
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["district"] == DISTRICT
    assert row["ds_division"] == DIVISION


def test_a_malformed_district_in_the_body_is_still_ignored_not_a_500(client, store, estimate_spy):
    """Pre-Epic-8 offline clients still send these fields; junk in them must not fail a report
    that is otherwise perfectly valid."""
    body = _body(district=999, ds_division="", ai_severity={"x": 1})
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 201
    assert store["rows"][body["offline_id"]]["district"] == DISTRICT
    assert estimate_spy[0]["ai_severity"] is None


# --- Story 8.4: the FR-10.3 registration gate ------------------------------------------------


def test_unregistered_citizen_cannot_submit(client, store):
    store["households"].clear()
    res = client.post(
        "/api/v1/cases/submit", json=_body(),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "not_registered"
    assert store["rows"] == {}


def test_a_revoked_household_cannot_submit(client, store):
    store["households"] = [_household(1, "HH-2026-0001", uid="officer-1", status="revoked")]
    res = client.post(
        "/api/v1/cases/submit", json=_body(),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 403


def test_a_citizen_cannot_claim_a_household_via_the_body(client, store):
    """The household comes from the JWT on this path. Naming someone else's reference in the body
    must not attach the case to their registration."""
    store["households"] = [_household(9, "HH-2026-0009", uid="somebody-else")]
    res = client.post(
        "/api/v1/cases/submit", json=_body(household_ref="HH-2026-0009"),
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert res.status_code == 403


def test_officer_assisted_submit_needs_a_real_household_ref(client, store):
    body = _body(submitted_by_officer=True, officer_id="officer-1",
                 household_ref="HH-2026-9999")
    res = client.post(
        "/api/v1/cases/submit", json=body,
        headers={"Authorization": f"Bearer {_officer_token()}"},
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "not_registered"


def test_an_accepted_case_stays_idempotent_after_the_household_is_revoked(client, store):
    """The gate sits AFTER the idempotency fast path on purpose: a retry of a case the platform
    already accepted must keep returning its canonical id, not start 403ing."""
    headers = {"Authorization": f"Bearer {_token()}"}
    first = client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    assert first.status_code == 201

    store["households"] = [_household(1, "HH-2026-0001", uid="officer-1", status="revoked")]
    retry = client.post("/api/v1/cases/submit", json=_body(), headers=headers)
    assert retry.status_code == 200
    assert retry.get_json()["canonical_id"] == first.get_json()["canonical_id"]


def test_submit_saves_locale(client, store):
    body = _body(locale="ta")
    res = client.post(
        "/api/v1/cases/submit", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert res.status_code == 201
    row = store["rows"][body["offline_id"]]
    assert row["locale"] == "ta"
