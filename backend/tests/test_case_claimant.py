"""Who submitted a case (2026-10-07) -- which staff may read the family behind it, and what they get.

The claimant view admits identity and contact details to staff for the first time, so these tests
pin the bounds that make it acceptable: the case's own scope and nothing wider, one audit row per
read, no NIC digest, no bank ciphertext, and the bank tail for the DS officer alone.

The DB is faked (no Postgres in CI); scope resolution is case_photos._resolve_case, whose SQL the
fake follows the same way test_case_photos.py's does.
"""
from datetime import datetime, timezone

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
GALNEWA = "ගල්නැව"
THALAWA = "තලාව"
ANURADHAPURA = "අනුරාධපුරය"
POLONNARUWA = "පොළොන්නරුව"

REF = "HEC-2026-0301"          # Galnewa, household 7
OTHER_REF = "HEC-2026-0302"    # Thalawa, household 7
SEEDED_REF = "HEC-2026-0010"   # Galnewa, no household (pre-Epic-8 / research seed)
OFFLINE = "4f1c1a5e-2b7e-4c3a-9d2e-0a1b2c3d4e5f"

HOUSEHOLD_KEYS = {"household_ref", "district", "ds_division", "gn_division", "status",
                  "registered_at", "address", "contact_email", "contact_mobile", "members"}


def _auth(sub, role=None, **meta):
    app_metadata = dict(meta)
    if role:
        app_metadata["role"] = role
    token = jwt.encode({"sub": sub, "app_metadata": app_metadata}, SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def _officer(divisions=(GALNEWA,), sub="officer-1"):
    return _auth(sub, "officer", assigned_divisions=list(divisions))


def _admin(district=ANURADHAPURA):
    return _auth("admin-1", "admin", district_id=district)


def _ds(division=GALNEWA):
    return _auth("ds-1", "ds_officer", ds_division=division)


class FakeCursor:
    """Follows the SQL this endpoint issues; anything unexpected fails the test loudly."""

    def __init__(self, store):
        self.store = store
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        self.store["sql"].append(s)

        if "pg_advisory_xact_lock" in s:
            self._rows = [(None,)]
        elif s.startswith("SELECT hash FROM audit_log"):
            self._rows = [(a["hash"],) for a in self.store["audit"][-1:]]
        elif s.startswith("SELECT c.id FROM cases c"):
            self._rows = [(c["id"],) for c in self.store["cases"].values()
                          if self._case_visible(c, s, params)]
        elif "FROM households WHERE id = (SELECT household_id FROM cases WHERE id = %s)" in s:
            # The projection is households.HOUSEHOLD_COLUMNS; a column outside it would be a leak.
            assert "nic_hmac" not in s and "ciphertext" not in s and "registrant_uid" not in s
            case = next(c for c in self.store["cases"].values() if c["id"] == params[0])
            h = self.store["households"].get(case["household_id"])
            self._rows = [] if h is None else [(
                h["id"], h["household_ref"], h["district"], h["ds_division"], h["gn_division"],
                h["status"], h["registered_at"], h["address"], h["contact_email"],
                h["bank_account_last4"], h["contact_mobile"],
            )]
        elif "FROM household_members" in s:
            assert "nic_hmac" not in s
            self._rows = [(m["full_name"], m["relationship"], m["is_registrant"])
                          for m in self.store["members"] if m["household_id"] == params[0]]
        elif "INSERT INTO audit_log" in s:
            self.store["audit"].append({"case_id": params[0], "event": params[1],
                                        "actor": params[2], "metadata": params[3],
                                        "hash": params[5]})
            self._rows = [(1,)]
        else:
            raise AssertionError(f"unexpected SQL: {s}")

    def _case_visible(self, case, sql, params):
        ref = params[0]
        if case["canonical_id"] != ref and case["offline_id"] != ref:
            return False
        if "c.citizen_id = %s" in sql:
            raise AssertionError("the claimant view must never resolve a case for a citizen")
        column = "district" if "district = ANY" in sql else "ds_division_id"
        in_scope = case[column] is not None and case[column] in params[1]
        if "c.officer_id = %s" in sql:
            return in_scope or case["officer_id"] == params[2]
        return in_scope

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConn:
    def __init__(self, store):
        self.store = store

    def cursor(self):
        return FakeCursor(self.store)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass


@pytest.fixture
def store():
    return {
        "cases": {
            REF: {"id": 301, "canonical_id": REF, "offline_id": OFFLINE, "district": ANURADHAPURA,
                  "ds_division_id": GALNEWA, "officer_id": None, "household_id": 7},
            OTHER_REF: {"id": 302, "canonical_id": OTHER_REF,
                        "offline_id": "11111111-1111-4111-8111-111111111111",
                        "district": ANURADHAPURA, "ds_division_id": THALAWA,
                        "officer_id": "officer-1", "household_id": 7},
            SEEDED_REF: {"id": 10, "canonical_id": SEEDED_REF,
                         "offline_id": "22222222-2222-4222-8222-222222222222",
                         "district": ANURADHAPURA, "ds_division_id": GALNEWA,
                         "officer_id": None, "household_id": None},
        },
        "households": {
            7: {"id": 7, "household_ref": "HH-2026-0007", "district": ANURADHAPURA,
                "ds_division": GALNEWA, "gn_division": "ගල්නැව උතුර", "status": "active",
                "registered_at": datetime(2026, 9, 20, 8, 30, tzinfo=timezone.utc),
                "address": "12, Temple Road, Galnewa", "contact_email": "family@example.lk",
                "bank_account_last4": "4321", "contact_mobile": "+94771234567",
                "nic_hmac": "deadbeef", "bank_details_ciphertext": "gAAAAAciphertext",
                "registrant_uid": "citizen-1"},
        },
        "members": [
            {"household_id": 7, "full_name": "K. M. Perera", "relationship": "self",
             "is_registrant": True},
            {"household_id": 7, "full_name": "S. Perera", "relationship": "spouse",
             "is_registrant": False},
        ],
        "audit": [],
        "sql": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                      "SUPABASE_JWT_SECRET": SECRET})
    monkeypatch.setattr("app.api.v1.case_claimant._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _get(client, ref, headers):
    return client.get(f"/api/v1/cases/{ref}/claimant", headers=headers)


def _all_keys(value):
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _all_keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _all_keys(v)}
    return set()


# --- who may read it -------------------------------------------------------

@pytest.mark.parametrize("headers", [_officer, _admin, _ds], ids=["officer", "admin", "ds_officer"])
def test_each_staff_role_in_scope_reads_the_household_and_its_members(client, headers):
    res = _get(client, REF, headers())
    assert res.status_code == 200
    h = res.get_json()["household"]
    assert h["household_ref"] == "HH-2026-0007"
    assert h["address"] == "12, Temple Road, Galnewa"
    assert h["contact_mobile"] == "+94771234567"
    assert h["contact_email"] == "family@example.lk"
    assert h["gn_division"] == "ගල්නැව උතුර"
    assert h["registered_at"].startswith("2026-09-20")
    assert h["members"] == [
        {"full_name": "K. M. Perera", "relationship": "self", "is_registrant": True},
        {"full_name": "S. Perera", "relationship": "spouse", "is_registrant": False},
    ]


def test_officer_and_admin_get_exactly_the_household_keys_without_the_bank_tail(client):
    for headers in (_officer(), _admin()):
        h = _get(client, REF, headers).get_json()["household"]
        assert set(h) == HOUSEHOLD_KEYS


def test_only_the_ds_officer_gets_the_bank_account_tail(client):
    h = _get(client, REF, _ds()).get_json()["household"]
    assert set(h) == HOUSEHOLD_KEYS | {"bank_account_last4"}
    assert h["bank_account_last4"] == "4321"


@pytest.mark.parametrize("headers", [_officer, _admin, _ds], ids=["officer", "admin", "ds_officer"])
def test_no_nic_digest_ciphertext_or_account_id_ever_leaves(client, headers):
    res = _get(client, REF, headers())
    body = res.get_json()
    assert not (_all_keys(body) & {"nic", "nic_hmac", "bank_details_ciphertext",
                                   "registrant_uid", "id", "account_number"})
    raw = res.get_data(as_text=True)
    assert "deadbeef" not in raw and "gAAAAA" not in raw and "citizen-1" not in raw


def test_the_offline_id_reaches_the_same_case(client):
    # The admin panel falls back to the offline id for a case that has no canonical id yet.
    assert _get(client, OFFLINE, _admin()).get_json()["household"]["household_ref"] == "HH-2026-0007"


# --- who may not -----------------------------------------------------------

def test_out_of_scope_staff_get_404_not_403(client):
    assert _get(client, REF, _officer(divisions=(THALAWA,), sub="officer-9")).status_code == 404
    assert _get(client, REF, _admin(district=POLONNARUWA)).status_code == 404
    assert _get(client, REF, _ds(division=THALAWA)).status_code == 404


def test_an_officer_reaches_a_case_they_submitted_outside_their_divisions(client):
    # officer_cases.py's rule: an officer-assisted submission stays workable for its submitter.
    assert _get(client, OTHER_REF, _officer(divisions=(GALNEWA,))).status_code == 200


def test_a_citizen_and_the_system_admin_are_never_told_the_case_exists(client, store):
    assert _get(client, REF, _auth("citizen-1")).status_code == 404
    assert _get(client, REF, _auth("sys-1", "system_admin")).status_code == 404
    assert store["sql"] == []          # refused before any query


def test_no_token_is_401(client):
    assert client.get(f"/api/v1/cases/{REF}/claimant").status_code == 401


def test_a_malformed_reference_is_404(client):
    assert _get(client, "not-a-ref", _admin()).status_code == 404


# --- the unlinked case and the audit trail ---------------------------------

def test_a_case_with_no_household_says_so(client):
    res = _get(client, SEEDED_REF, _ds())
    assert res.status_code == 200
    assert res.get_json() == {"household": None}


def test_every_read_is_audited_with_the_role_and_no_values(client, store):
    _get(client, REF, _officer())
    _get(client, SEEDED_REF, _ds())
    rows = [a for a in store["audit"] if a["event"] == "case_claimant_viewed"]
    assert [(r["case_id"], r["actor"]) for r in rows] == [(301, "officer-1"), (10, "ds-1")]
    metadata = " ".join(str(r["metadata"]) for r in rows)
    assert '"role": "officer"' in metadata or "'role': 'officer'" in metadata
    assert "Temple Road" not in metadata and "+9477" not in metadata and "Perera" not in metadata


def test_out_of_scope_reads_write_no_audit_row(client, store):
    _get(client, REF, _ds(division=THALAWA))
    assert store["audit"] == []
