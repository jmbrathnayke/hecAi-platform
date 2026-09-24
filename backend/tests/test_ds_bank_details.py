"""PUT /api/v1/households/<ref>/bank-details — the DS office records or corrects an account.

WHY THIS ENDPOINT EXISTS AT ALL. A citizen may ADD bank details they skipped at registration, but
never replace details already on file: whoever held the family's session could otherwise redirect
the compensation. Correcting a mistyped or closed account is a real need, so it happens here — at
the office that pays, against a person presenting evidence, with a written reason recorded.
"""
import json

import jwt
import pytest
from cryptography.fernet import Fernet

from app import create_app
from app.infrastructure.security.bank_crypto import decrypt_bank_details, encrypt_bank_details

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
BANK_KEY = Fernet.generate_key().decode("ascii")
THALAWA = "තලාව"
KEKIRAWA = "කැකිරාව"

NEW_DETAILS = {
    "account_number": "7009876543210",
    "bank_name": "People's Bank",
    "branch": "Thalawa",
    "account_holder": "Test Registrant",
}
REASON = "Account closed; family presented a new passbook at the DS office."


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
        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif "SELECT hash FROM audit_log" in s:
            rows = self.store["audit"]
            self._one = (rows[-1]["hash"],) if rows else None
        elif s.startswith("INSERT INTO audit_log"):
            self.store["audit"].append({
                "case_id": params[0], "event": params[1], "actor_id": params[2],
                "metadata": params[3], "hash": params[5],
            })
            self._one = None
        elif s.startswith("SELECT id, bank_details_ciphertext IS NOT NULL"):
            ref, division = params
            hit = next((h for h in self.store["households"].values()
                        if h["household_ref"] == ref and h["ds_division"] == division
                        and h["status"] == "active"), None)
            self._one = (hit["id"], hit["bank_details_ciphertext"] is not None) if hit else None
        elif s.startswith("UPDATE households SET bank_details_ciphertext"):
            ciphertext, last4, household_id = params
            self.store["households"][household_id].update(
                bank_details_ciphertext=ciphertext, bank_account_last4=last4)
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
    ciphertext, last4 = encrypt_bank_details(
        {"account_number": "8001234567890", "bank_name": "Bank of Ceylon"}, BANK_KEY)
    return {
        "households": {
            1: {"id": 1, "household_ref": "HH-2026-0001", "ds_division": THALAWA,
                "status": "active", "bank_details_ciphertext": ciphertext,
                "bank_account_last4": last4},
            2: {"id": 2, "household_ref": "HH-2026-0002", "ds_division": THALAWA,
                "status": "active", "bank_details_ciphertext": None, "bank_account_last4": None},
            3: {"id": 3, "household_ref": "HH-2026-0003", "ds_division": KEKIRAWA,
                "status": "active", "bank_details_ciphertext": None, "bank_account_last4": None},
        },
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET, "BANK_DETAILS_KEY": BANK_KEY,
    })
    monkeypatch.setattr("app.api.v1.ds._get_connection", lambda: FakeConn(store))
    return app.test_client()


@pytest.fixture
def nokey_client(monkeypatch, store):
    app = create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET, "BANK_DETAILS_KEY": None,
    })
    monkeypatch.setattr("app.api.v1.ds._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _put(client, ref="HH-2026-0001", bank=NEW_DETAILS, reason=REASON, **kw):
    body = {}
    if bank is not None:
        body["bank"] = bank
    if reason is not None:
        body["reason"] = reason
    return client.put(f"/api/v1/households/{ref}/bank-details", json=body, headers=_auth(**kw))


# --------------------------------------------------------------------- happy path
def test_replaces_an_account_the_citizen_may_not_change_themselves(client, store):
    res = _put(client)
    assert res.status_code == 200
    assert res.get_json() == {
        "household_ref": "HH-2026-0001", "bank_account_last4": "3210", "replaced_existing": True,
    }
    stored = store["households"][1]
    assert stored["bank_account_last4"] == "3210"
    assert decrypt_bank_details(stored["bank_details_ciphertext"], BANK_KEY)["account_number"] \
        == NEW_DETAILS["account_number"]


def test_records_details_for_a_family_that_had_none(client, store):
    res = _put(client, ref="HH-2026-0002")
    assert res.status_code == 200
    assert res.get_json()["replaced_existing"] is False
    assert store["households"][2]["bank_details_ciphertext"] is not None


def test_a_lowercase_reference_still_matches(client):
    assert _put(client, ref="hh-2026-0001").status_code == 200


# --------------------------------------------------------------------- the audit trail
def test_the_audit_row_records_why_but_never_the_account_number(client, store):
    _put(client)
    entry = store["audit"][-1]
    assert entry["event"] == "ds_set_household_bank_details"
    assert entry["actor_id"] == "ds-1"
    assert entry["case_id"] is None
    meta = entry["metadata"]
    meta = json.loads(meta) if isinstance(meta, str) else meta
    assert meta["household_ref"] == "HH-2026-0001"
    assert meta["replaced_existing"] is True
    assert meta["reason"] == REASON
    blob = json.dumps(meta, ensure_ascii=False)
    assert NEW_DETAILS["account_number"] not in blob
    assert "8001234567890" not in blob  # nor the one it replaced
    assert "3210" not in blob


def test_a_refused_change_writes_no_audit_row(client, store):
    _put(client, reason="too short")
    _put(client, ref="HH-2026-0003")  # another division
    assert store["audit"] == []


# --------------------------------------------------------------------- refusals
def test_a_written_reason_is_required(client, store):
    res = _put(client, reason="short")
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"
    assert store["households"][1]["bank_account_last4"] != "3210"


@pytest.mark.parametrize("bank", [None, {}, {"bank_name": "BOC"}, {"account_number": "   "}])
def test_malformed_bank_details_are_refused(client, store, bank):
    res = _put(client, bank=bank)
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_bank_details"
    assert store["households"][1]["bank_account_last4"] != "3210"


def test_a_household_in_another_division_is_a_404_not_a_403(client, store):
    """A distinct 403 would confirm that a household exists outside this officer's division."""
    res = _put(client, ref="HH-2026-0003")
    assert res.status_code == 404
    assert store["households"][3]["bank_details_ciphertext"] is None


def test_an_unknown_household_is_also_a_404(client):
    assert _put(client, ref="HH-2026-9999").status_code == 404


def test_no_key_configured_fails_closed(nokey_client, store):
    res = nokey_client.put("/api/v1/households/HH-2026-0001/bank-details",
                           json={"bank": NEW_DETAILS, "reason": REASON}, headers=_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"
    assert store["households"][1]["bank_account_last4"] != "3210"


@pytest.mark.parametrize("role", [None, "officer", "admin", "system_admin"])
def test_only_a_ds_officer_may_change_an_account(client, store, role):
    res = _put(client, role=role)
    assert res.status_code == 403
    assert store["households"][1]["bank_account_last4"] != "3210"


def test_requires_a_token(client):
    res = client.put("/api/v1/households/HH-2026-0001/bank-details",
                     json={"bank": NEW_DETAILS, "reason": REASON})
    assert res.status_code == 401


def test_a_ds_officer_with_no_division_is_refused(client):
    assert _put(client, division=None).status_code == 403


def test_the_response_never_carries_the_full_account_number(client):
    blob = _put(client).get_data(as_text=True)
    assert NEW_DETAILS["account_number"] not in blob
    assert "ciphertext" not in blob
