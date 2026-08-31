"""Story 8.7 — DS-initiated registration transfer (FR-10.5).

THE POINT OF THIS FEATURE, stated so the tests can be read against it: a household is registered
against one person, and every family member's NIC is occupied by that registration. If the
registrant dies, nobody in the family can re-register, so a control built to protect them locks
them out of compensation instead. This endpoint is the release valve.

The most important test in this file is therefore not the happy path — it is
`test_the_family_can_still_report_after_a_transfer`, which is the requirement itself.
"""
import json
import re

import jwt
import pytest

from app import create_app
from app.infrastructure.security.nic_identity import nic_hmac

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
PEPPER = "test-pepper-not-a-real-secret"

THALAWA = "තලාව"
KEKIRAWA = "කැකිරාව"

NIC_FATHER = "200133502343"   # the registrant who dies
NIC_SON = "751234567V"        # a declared member
NIC_SON_LEGACY = "013350234V"  # NOT the son — the father's other card (see the format test)
NIC_STRANGER = "851234567V"   # nobody in this household

REASON = "Registrant deceased; death certificate presented at the DS office."


def _token(sub="ds-1", role="ds_officer", division=THALAWA):
    meta = {}
    if role is not None:
        meta["role"] = role
    if division is not None:
        meta["ds_division"] = division
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._one = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        st = self.store

        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif "SELECT hash FROM audit_log" in s:
            self._one = (st["audit"][-1]["hash"],) if st["audit"] else None
        elif s.startswith("INSERT INTO audit_log"):
            st["audit"].append({"case_id": params[0], "event": params[1], "actor_id": params[2],
                                "metadata": params[3], "hash": params[5]})
            self._one = None
        elif "SELECT id, status FROM households" in s:
            ref, division = params
            h = st["households"].get(ref)
            # Honour what the STATEMENT says, not what we assume it says. If the division
            # predicate is removed from the SQL, this fake must stop filtering by division too —
            # otherwise the fake silently enforces a rule the code no longer does, and a test
            # asserting cross-division isolation passes for the wrong reason.
            scoped = "ds_division = %s" in s
            ok = h is not None and (not scoped or h["ds_division"] == division)
            self._one = (h["id"], h["status"]) if ok else None
        elif "SELECT id, is_registrant FROM household_members" in s:
            household_id, digest = params
            m = next((m for m in st["members"]
                      if m["household_id"] == household_id and m["nic_hmac"] == digest), None)
            self._one = (m["id"], m["is_registrant"]) if m else None
        elif "SET is_registrant = FALSE" in s:
            (household_id,) = params
            for m in st["members"]:
                if m["household_id"] == household_id:
                    m["is_registrant"] = False
            self._one = None
        elif "SET is_registrant = TRUE" in s:
            (member_id,) = params
            for m in st["members"]:
                if m["id"] == member_id:
                    m["is_registrant"] = True
            self._one = None
        elif s.startswith("UPDATE households"):
            # Apply EVERY column the statement sets, not just the one we expect. Modelling only
            # registrant_uid made this fake blind to a status write — and a status write is
            # precisely the FR-10.5 bug the tests below exist to prevent, so the fake was
            # concealing the failure it was supposed to expose.
            household_id = params[-1]
            for h in st["households"].values():
                if h["id"] != household_id:
                    continue
                if "registrant_uid = NULL" in s:
                    h["registrant_uid"] = None
                m = re.search(r"status = '([a-z]+)'", s)
                if m:
                    h["status"] = m.group(1)
                elif "status = %s" in s:
                    h["status"] = params[0]
            self._one = None
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one


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
        "households": {
            "HH-2026-0001": {"id": 1, "ds_division": THALAWA, "status": "active",
                             "registrant_uid": "citizen-father"},
            "HH-2026-0002": {"id": 2, "ds_division": THALAWA, "status": "revoked",
                             "registrant_uid": "citizen-x"},
            "HH-2026-0009": {"id": 9, "ds_division": KEKIRAWA, "status": "active",
                             "registrant_uid": "citizen-y"},
        },
        "members": [
            {"id": 11, "household_id": 1, "nic_hmac": nic_hmac(NIC_FATHER, PEPPER),
             "is_registrant": True},
            {"id": 12, "household_id": 1, "nic_hmac": nic_hmac(NIC_SON, PEPPER),
             "is_registrant": False},
        ],
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET, "NIC_PEPPER": PEPPER,
    })
    monkeypatch.setattr("app.api.v1.ds._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _post(client, ref="HH-2026-0001", nic=NIC_SON, reason=REASON, **kw):
    body = {}
    if nic is not None:
        body["new_registrant_nic"] = nic
    if reason is not None:
        body["reason"] = reason
    return client.post(f"/api/v1/households/{ref}/transfer", json=body, headers=_auth(**kw))


# --------------------------------------------------------------- the requirement itself
def test_the_family_can_still_report_after_a_transfer(client, store):
    """FR-10.5 in one assertion: the household stays ACTIVE, so the submit gate still admits it.

    If a transfer moved the status to 'transferred', registry.py would stop admitting the
    household and the family would be permanently locked out of compensation — the exact harm
    this feature exists to prevent. Migration 023's original comment specified that wrong
    behaviour; this test is what stops it coming back.
    """
    assert _post(client).status_code == 200
    assert store["households"]["HH-2026-0001"]["status"] == "active"


def test_registrant_status_moves_to_the_new_person(client, store):
    _post(client)
    by_id = {m["id"]: m for m in store["members"]}
    assert by_id[11]["is_registrant"] is False   # the father
    assert by_id[12]["is_registrant"] is True    # the son


def test_exactly_one_registrant_remains(client, store):
    _post(client)
    registrants = [m for m in store["members"] if m["household_id"] == 1 and m["is_registrant"]]
    assert len(registrants) == 1


def test_the_old_registrant_row_is_kept(client, store):
    """Deleting it would free the deceased's NIC for a fresh registration elsewhere and erase the
    family's declared composition."""
    _post(client)
    assert any(m["id"] == 11 for m in store["members"])


def test_the_supabase_account_link_is_cleared(client, store):
    """registrant_uid holds an app account the DS office cannot know for the new person. Leaving
    the dead registrant's account attached would let it keep acting for the family."""
    _post(client)
    assert store["households"]["HH-2026-0001"]["registrant_uid"] is None


# --------------------------------------------------------------- who may be transferred to
def test_the_new_registrant_must_already_be_a_declared_member(client, store):
    """Otherwise this is a back door for registering someone into a family they were never part
    of — which would defeat FR-10.2 at the same time."""
    res = _post(client, nic=NIC_STRANGER)
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_a_member"
    # Nothing moved.
    assert next(m for m in store["members"] if m["id"] == 11)["is_registrant"] is True


def test_transferring_to_the_current_registrant_is_refused(client):
    res = _post(client, nic=NIC_FATHER)
    assert res.status_code == 409
    assert res.get_json()["error"] == "already_registrant"


def test_either_card_format_identifies_the_same_person(client):
    """The father's legacy card must resolve to the father, so the no-op is still detected."""
    res = _post(client, nic=NIC_SON_LEGACY)
    assert res.status_code == 409
    assert res.get_json()["error"] == "already_registrant"


# --------------------------------------------------------------- guards
def test_a_reason_is_required(client, store):
    res = _post(client, reason=None)
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"
    assert store["audit"] == []


def test_a_token_reason_is_not_enough(client):
    """Same 10-character floor as an AI override and an admin case action."""
    res = _post(client, reason="died")
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_an_invalid_nic_is_rejected(client):
    assert _post(client, nic="junk").status_code == 400


def test_a_household_in_another_division_is_a_404(client):
    """Not a 403 — that would confirm the household exists outside this officer's division."""
    res = _post(client, ref="HH-2026-0009")
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_an_unknown_household_is_a_404(client):
    assert _post(client, ref="HH-2026-9999").status_code == 404


def test_a_revoked_household_cannot_be_transferred(client):
    res = _post(client, ref="HH-2026-0002")
    assert res.status_code == 409
    assert res.get_json()["error"] == "household_not_active"


@pytest.mark.parametrize("role", ["officer", "admin", "system_admin", None])
def test_only_a_ds_officer_may_transfer(client, role, store):
    assert _post(client, role=role).status_code == 403
    assert store["audit"] == []


def test_requires_a_token(client):
    assert client.post("/api/v1/households/HH-2026-0001/transfer", json={}).status_code == 401


def test_a_ds_officer_with_no_division_is_refused(client):
    assert _post(client, division=None).status_code == 403


# --------------------------------------------------------------- audit
def test_the_transfer_is_audit_logged_with_the_reason(client, store):
    _post(client)
    entry = store["audit"][-1]
    assert entry["event"] == "household_registrant_transferred"
    assert entry["actor_id"] == "ds-1"
    metadata = json.loads(entry["metadata"])
    assert metadata["household_ref"] == "HH-2026-0001"
    assert metadata["reason"] == REASON
    assert metadata["ds_division"] == THALAWA


def test_the_audit_entry_carries_no_nic_or_digest(client, store):
    _post(client)
    blob = store["audit"][-1]["metadata"]
    assert NIC_FATHER not in blob
    assert NIC_SON not in blob
    assert nic_hmac(NIC_SON, PEPPER) not in blob


def test_a_refused_transfer_writes_no_audit_row(client, store):
    """An attempt that changed nothing must not appear as though something happened."""
    _post(client, nic=NIC_STRANGER)
    assert store["audit"] == []


def test_the_response_carries_no_nic(client):
    blob = _post(client).get_data(as_text=True)
    assert NIC_SON not in blob
    assert NIC_FATHER not in blob
