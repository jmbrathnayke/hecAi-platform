"""Tests for the household registration API (Story 8.2, FR-10.1/10.2/10.6).

DB faked, but the fake ENFORCES the UNIQUE index on household_members.nic_hmac. That is
deliberate: the duplicate-claim control IS that index, so a fake that let duplicates through
would make every "is blocked" test below pass for the wrong reason.
"""
import json

import jwt
import psycopg2
import pytest
from cryptography.fernet import Fernet

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256
PEPPER = "test-pepper-not-a-real-secret"
# A real Fernet key — generated once and pinned, so these tests do not depend on
# key generation and a decrypt failure means the code is wrong, not the fixture.
BANK_KEY = Fernet.generate_key().decode("ascii")

DISTRICT = "අනුරාධපුරය"
DIVISION = "තලාව"

# One person, two cards. Registering with either must occupy the same slot.
NIC_CURRENT = "200133502343"
NIC_LEGACY = "013350234V"
NIC_OTHER = "751234567V"
NIC_THIRD = "851234567V"


def _token(sub="citizen-1", role=None):
    meta = {"role": role} if role is not None else {}
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _payload(nic=NIC_CURRENT, members=None, **over):
    body = {
        "nic": nic,
        "full_name": "Test Registrant",
        "district": DISTRICT,
        "ds_division": DIVISION,
        "members": members if members is not None else [],
    }
    body.update(over)
    return body


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._rows = []
        self._one = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    # -- helpers -------------------------------------------------------------
    def _insert_member(self, household_id, nic_hmac, is_registrant, full_name, relationship):
        # THE CONTROL. Mirrors ux_household_members_nic; without this the tests prove nothing.
        if any(m["nic_hmac"] == nic_hmac for m in self.store["members"]):
            raise psycopg2.errors.UniqueViolation("duplicate key value violates ux_household_members_nic")
        if is_registrant and any(
            m["household_id"] == household_id and m["is_registrant"] for m in self.store["members"]
        ):
            raise psycopg2.errors.UniqueViolation("duplicate key value violates ux_household_one_registrant")
        self.store["members"].append({
            "household_id": household_id, "nic_hmac": nic_hmac,
            "is_registrant": is_registrant, "full_name": full_name, "relationship": relationship,
        })

    # -- SQL router ----------------------------------------------------------
    def execute(self, sql, params=()):
        s = " ".join(sql.split())

        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif "SELECT hash FROM audit_log" in s:
            rows = self.store["audit"]
            self._one = (rows[-1]["hash"],) if rows else None
        elif s.startswith("INSERT INTO audit_log"):
            self.store["audit"].append({
                "case_id": params[0], "event": params[1], "actor_id": params[2],
                "metadata": params[3], "hash": params[5], "prev_hash": params[6],
            })
            self._one = None
        elif "SELECT household_ref FROM households" in s and "registrant_uid" in s:
            hit = next((h for h in self.store["households"]
                        if h["registrant_uid"] == params[0] and h["status"] == "active"), None)
            self._one = (hit["household_ref"],) if hit else None
        elif s.startswith("SELECT h.id, h.household_ref"):
            # registry.resolve_by_nic — one household by ONE digest. Matched before the
            # registration-conflict query below, which shares the same JOIN clause but takes a
            # digest ARRAY and returns rows rather than a single household.
            digest, status = params
            member = next((m for m in self.store["members"] if m["nic_hmac"] == digest), None)
            hit = next((h for h in self.store["households"]
                        if member and h["id"] == member["household_id"]
                        and h["status"] == status), None)
            self._one = (hit["id"], hit["household_ref"], hit["district"],
                         hit["ds_division"], hit["status"]) if hit else None
        elif "FROM household_members m JOIN households h" in s:
            wanted = set(params[0])
            by_id = {h["id"]: h for h in self.store["households"]}
            self._rows = [(m["nic_hmac"], by_id[m["household_id"]]["household_ref"])
                          for m in self.store["members"] if m["nic_hmac"] in wanted]
        elif "nextval('hec_household_seq')" in s:
            self.store["seq"] += 1
            self._one = (self.store["seq"],)
        elif s.startswith("INSERT INTO households"):
            ref, district, ds_division, gn, uid, bank_ct, bank_last4 = params
            new_id = len(self.store["households"]) + 1
            self.store["households"].append({
                "id": new_id, "household_ref": ref, "district": district,
                "ds_division": ds_division, "gn_division": gn, "registrant_uid": uid,
                "status": "active", "registered_at": None,
                "bank_details_ciphertext": bank_ct, "bank_account_last4": bank_last4,
            })
            self._one = (new_id,)
        elif s.startswith("INSERT INTO household_members"):
            self._insert_member(*params)
            self._one = None
        elif "SELECT id, household_ref, district, ds_division" in s:
            hit = next((h for h in self.store["households"]
                        if h["registrant_uid"] == params[0] and h["status"] == "active"), None)
            self._one = (hit["id"], hit["household_ref"], hit["district"], hit["ds_division"],
                         hit["gn_division"], hit["status"], hit["registered_at"]) if hit else None
        elif "SELECT full_name, relationship, is_registrant" in s:
            self._rows = [(m["full_name"], m["relationship"], m["is_registrant"])
                          for m in self.store["members"] if m["household_id"] == params[0]]
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def executemany(self, sql, seq_of_params):
        for p in seq_of_params:
            self.execute(sql, p)

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
    return {"households": [], "members": [], "audit": [], "seq": 0}


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET, "NIC_PEPPER": PEPPER,
        "BANK_DETAILS_KEY": BANK_KEY,
    })
    monkeypatch.setattr("app.api.v1.households._get_connection", lambda: FakeConn(store))
    return app.test_client()


@pytest.fixture
def nopepper_client(monkeypatch, store):
    app = create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET, "NIC_PEPPER": None,
    })
    monkeypatch.setattr("app.api.v1.households._get_connection", lambda: FakeConn(store))
    return app.test_client()


# --------------------------------------------------------------------------- happy path
def test_registers_and_returns_a_household_ref(client):
    res = client.post("/api/v1/households", json=_payload(), headers=_auth())
    assert res.status_code == 201
    body = res.get_json()
    assert body["household_ref"].startswith("HH-")
    assert body["household_ref"].endswith("-0001")
    assert body["district"] == DISTRICT
    assert body["ds_division"] == DIVISION
    assert body["member_count"] == 1


def test_registrant_and_members_are_stored_with_one_registrant(client, store):
    members = [{"nic": NIC_OTHER, "full_name": "Son", "relationship": "son"}]
    res = client.post("/api/v1/households", json=_payload(members=members), headers=_auth())
    assert res.status_code == 201
    assert res.get_json()["member_count"] == 2
    assert len(store["members"]) == 2
    assert sum(1 for m in store["members"] if m["is_registrant"]) == 1
    assert {m["full_name"] for m in store["members"]} == {"Test Registrant", "Son"}


def test_members_may_be_bare_nic_strings(client, store):
    res = client.post("/api/v1/households", json=_payload(members=[NIC_OTHER]), headers=_auth())
    assert res.status_code == 201
    assert len(store["members"]) == 2


def test_registration_is_audit_logged_without_any_nic(client, store):
    client.post("/api/v1/households", json=_payload(members=[NIC_OTHER]), headers=_auth())
    assert len(store["audit"]) == 1
    entry = store["audit"][0]
    assert entry["event"] == "household_registered"
    assert entry["actor_id"] == "citizen-1"
    blob = json.dumps(entry["metadata"], ensure_ascii=False)
    assert NIC_CURRENT not in blob and NIC_OTHER not in blob


# --------------------------------------------------------------------------- the control
def test_second_family_member_registering_separately_is_blocked(client):
    """The FR-10.2 property, through the API. This is the dissertation's demo."""
    first = client.post("/api/v1/households",
                        json=_payload(members=[NIC_OTHER]), headers=_auth())
    assert first.status_code == 201

    # The son, on his own account, tries to register his own household.
    second = client.post("/api/v1/households",
                         json=_payload(nic=NIC_OTHER), headers=_auth(sub="citizen-2"))
    assert second.status_code == 409
    assert second.get_json()["error"] == "nic_already_registered"


def test_the_legacy_card_of_a_registered_person_is_also_blocked(client):
    """The format bypass, closed end-to-end: registered with the 12-digit card, blocked when
    presenting the 9-digit one. Without canonical_nic() this returns 201."""
    assert client.post("/api/v1/households", json=_payload(nic=NIC_CURRENT),
                       headers=_auth()).status_code == 201

    res = client.post("/api/v1/households", json=_payload(nic=NIC_LEGACY),
                      headers=_auth(sub="citizen-2"))
    assert res.status_code == 409
    assert res.get_json()["error"] == "nic_already_registered"


def test_registrant_conflict_names_the_household_so_the_citizen_can_quote_it(client):
    client.post("/api/v1/households", json=_payload(members=[NIC_OTHER]), headers=_auth())
    res = client.post("/api/v1/households", json=_payload(nic=NIC_OTHER),
                      headers=_auth(sub="citizen-2"))
    body = res.get_json()
    assert body["scope"] == "registrant"
    assert body["household_ref"].startswith("HH-")


def test_member_conflict_does_not_leak_the_other_household(client):
    """Enumeration guard: a clash on a DECLARED MEMBER names neither the member nor the family."""
    client.post("/api/v1/households", json=_payload(members=[NIC_OTHER]), headers=_auth())
    res = client.post("/api/v1/households",
                      json=_payload(nic=NIC_THIRD, members=[NIC_OTHER]),
                      headers=_auth(sub="citizen-2"))
    assert res.status_code == 409
    body = res.get_json()
    assert body["scope"] == "member"
    assert "household_ref" not in body


def test_same_account_cannot_register_twice(client):
    client.post("/api/v1/households", json=_payload(), headers=_auth())
    res = client.post("/api/v1/households", json=_payload(nic=NIC_OTHER), headers=_auth())
    assert res.status_code == 409
    assert res.get_json()["error"] == "already_registered"
    assert res.get_json()["household_ref"].startswith("HH-")


def test_unrelated_person_can_still_register(client):
    client.post("/api/v1/households", json=_payload(), headers=_auth())
    res = client.post("/api/v1/households", json=_payload(nic=NIC_OTHER),
                      headers=_auth(sub="citizen-2"))
    assert res.status_code == 201


# --------------------------------------------------------------------------- validation
def test_rejects_a_division_from_another_district(client):
    """තලාව is real and අම්පාර is real, but that pairing is not — accepting it would route the
    family's cases to officers in the wrong district (FR-10.6)."""
    res = client.post("/api/v1/households",
                      json=_payload(district="අම්පාර"), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_division"


def test_rejects_an_unknown_division(client):
    res = client.post("/api/v1/households",
                      json=_payload(ds_division="Nowhere"), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_division"


@pytest.mark.parametrize("missing", ["district", "ds_division"])
def test_requires_district_and_division(client, missing):
    body = _payload()
    del body[missing]
    res = client.post("/api/v1/households", json=body, headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "missing_fields"


@pytest.mark.parametrize("bad", ["", "12345", "abcdefghiV", None])
def test_rejects_a_malformed_registrant_nic(client, bad):
    res = client.post("/api/v1/households", json=_payload(nic=bad), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_nic"


def test_rejects_the_same_nic_listed_twice_in_one_form(client):
    res = client.post("/api/v1/households",
                      json=_payload(members=[NIC_CURRENT]), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "duplicate_nic_in_form"


def test_rejects_the_same_person_listed_under_both_card_formats(client):
    """Same trap as above, but only canonicalisation catches it."""
    res = client.post("/api/v1/households",
                      json=_payload(nic=NIC_CURRENT, members=[NIC_LEGACY]), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "duplicate_nic_in_form"


def test_rejects_too_many_members(client):
    members = [f"{i:09d}V" for i in range(30)]
    res = client.post("/api/v1/households", json=_payload(members=members), headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_members"


def test_rejects_members_that_are_not_a_list(client):
    res = client.post("/api/v1/households", json=_payload(members={"nic": NIC_OTHER}),
                      headers=_auth())
    assert res.status_code == 400


# --------------------------------------------------------------------------- auth & config
def test_requires_a_token(client):
    res = client.post("/api/v1/households", json=_payload())
    assert res.status_code == 401


@pytest.mark.parametrize("role", ["officer", "admin"])
def test_staff_tokens_are_rejected(client, role):
    res = client.post("/api/v1/households", json=_payload(), headers=_auth(role=role))
    assert res.status_code == 403


def test_missing_pepper_is_a_server_error_not_a_bad_request(nopepper_client, store):
    """Fails closed. A default pepper would write digests anyone could recompute from the repo."""
    res = nopepper_client.post("/api/v1/households", json=_payload(), headers=_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"
    assert store["households"] == []


# --------------------------------------------------------------------------- PII discipline
def test_no_nic_or_digest_appears_in_any_response(client):
    created = client.post("/api/v1/households",
                          json=_payload(members=[NIC_OTHER]), headers=_auth())
    mine = client.get("/api/v1/households/me", headers=_auth())
    for res in (created, mine):
        blob = res.get_data(as_text=True)
        assert NIC_CURRENT not in blob
        assert NIC_OTHER not in blob
        assert "nic_hmac" not in blob


def test_conflict_response_carries_no_nic(client):
    client.post("/api/v1/households", json=_payload(), headers=_auth())
    res = client.post("/api/v1/households", json=_payload(nic=NIC_CURRENT),
                      headers=_auth(sub="citizen-2"))
    assert NIC_CURRENT not in res.get_data(as_text=True)


# --------------------------------------------------------------------------- GET /me
def test_me_returns_404_before_registration(client):
    res = client.get("/api/v1/households/me", headers=_auth())
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_registered"


def test_me_returns_the_household_and_its_members(client):
    client.post("/api/v1/households",
                json=_payload(members=[{"nic": NIC_OTHER, "full_name": "Son",
                                        "relationship": "son"}],
                              gn_division="Some GN"),
                headers=_auth())
    res = client.get("/api/v1/households/me", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    assert body["household_ref"].startswith("HH-")
    assert body["district"] == DISTRICT
    assert body["ds_division"] == DIVISION
    assert body["gn_division"] == "Some GN"
    assert body["status"] == "active"
    assert len(body["members"]) == 2
    assert body["members"][0]["is_registrant"] is True


def test_me_does_not_return_another_citizens_household(client):
    client.post("/api/v1/households", json=_payload(), headers=_auth())
    res = client.get("/api/v1/households/me", headers=_auth(sub="citizen-2"))
    assert res.status_code == 404


def test_me_requires_a_token(client):
    assert client.get("/api/v1/households/me").status_code == 401


# --- Story 8.5: POST /households/lookup (officer-assisted path) ------------------------------
#
# Story 8.4 gated cases/submit on a household_ref, but the officer app had no way to obtain one:
# it AES-GCM encrypts the citizen's NIC with a non-extractable device key, so the reference can be
# derived neither client-side nor from the stored ciphertext. Without this endpoint,
# officer-assisted submission cannot complete at all.


def _officer_token(sub="officer-1"):
    return jwt.encode(
        {"sub": sub, "app_metadata": {"role": "officer", "assigned_divisions": [DIVISION]}},
        SECRET, algorithm="HS256",
    )


def _officer_auth():
    return {"Authorization": f"Bearer {_officer_token()}"}


def test_lookup_returns_the_household_reference_for_a_registered_nic(client):
    client.post("/api/v1/households", json=_payload(), headers=_auth())
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_CURRENT},
                      headers=_officer_auth())
    assert res.status_code == 200
    body = res.get_json()
    assert body["household_ref"].startswith("HH-")
    assert body["district"] == DISTRICT
    assert body["ds_division"] == DIVISION


def test_lookup_finds_a_declared_member_not_only_the_registrant(client):
    """A son covered by his father's registration must be findable, or an officer standing in
    front of him cannot file his family's case."""
    client.post("/api/v1/households", json=_payload(members=[NIC_OTHER]), headers=_auth())
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_OTHER},
                      headers=_officer_auth())
    assert res.status_code == 200


def test_lookup_accepts_either_card_format(client):
    client.post("/api/v1/households", json=_payload(nic=NIC_CURRENT), headers=_auth())
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_LEGACY},
                      headers=_officer_auth())
    assert res.status_code == 200


def test_lookup_404s_for_an_unregistered_nic(client):
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_THIRD},
                      headers=_officer_auth())
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_registered"


def test_lookup_404s_for_a_malformed_nic_without_saying_which(client):
    """Same response as "not registered": distinguishing them would confirm that a well-formed
    NIC exists in the registry."""
    res = client.post("/api/v1/households/lookup", json={"nic": "junk"},
                      headers=_officer_auth())
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_registered"


def test_lookup_never_returns_the_member_list(client):
    """The officer needs a reference to file a case, not the family's composition."""
    client.post("/api/v1/households",
                json=_payload(members=[{"nic": NIC_OTHER, "full_name": "Son"}]),
                headers=_auth())
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_CURRENT},
                      headers=_officer_auth())
    blob = res.get_data(as_text=True)
    assert "members" not in blob
    assert "Son" not in blob
    assert NIC_CURRENT not in blob
    assert "nic_hmac" not in blob


def test_lookup_is_officer_only(client):
    """Citizens must not get this probe: it answers "is this NIC registered, and where", which is
    exactly what the registration endpoint withholds from them."""
    res = client.post("/api/v1/households/lookup", json={"nic": NIC_CURRENT}, headers=_auth())
    assert res.status_code == 403


def test_lookup_requires_a_token(client):
    assert client.post("/api/v1/households/lookup", json={"nic": NIC_CURRENT}).status_code == 401


def test_lookup_fails_closed_with_no_pepper(nopepper_client):
    res = nopepper_client.post("/api/v1/households/lookup", json={"nic": NIC_CURRENT},
                               headers=_officer_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"
