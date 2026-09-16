"""Story 8.6 — Divisional Secretariat payment authorisation (FR-10.4 / FR-5.6).

This endpoint is the ONE place on the platform where a citizen's full bank account number becomes
readable. Most of what follows is about the boundary around that, not the happy path.
"""
import json
import pathlib
import re
from datetime import datetime

import jwt
import pytest
from cryptography.fernet import Fernet

from app import create_app
from app.infrastructure.security.bank_crypto import encrypt_bank_details

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
BANK_KEY = Fernet.generate_key().decode("ascii")

THALAWA = "තලාව"
KEKIRAWA = "කැකිරාව"

DETAILS = {
    "account_number": "8001234567890",
    "bank_name": "Bank of Ceylon",
    "branch": "Thalawa",
    "account_holder": "Test Registrant",
}


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
        self._rows = []

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
            self.store["audit"].append(
                {"case_id": params[0], "event": params[1], "actor_id": params[2],
                 "metadata": params[3], "hash": params[5]}
            )
            self._one = None
        elif "SELECT c.id, c.status, c.approved_amount" in s:
            canonical, division = params
            c = self.store["cases"].get(canonical)
            if not c or c["ds_division_id"] != division:
                self._one = None
            else:
                h = self.store["households"].get(c["household_id"])
                # ds_authorized_at comes from the LEFT JOIN on payment_authorizations and is what
                # tells the endpoint whether this is the FIRST authorisation. Modelling it as
                # always-None would make every repeat reveal look like a first one, and the test
                # asserting a citizen is not re-notified would pass without the code being right.
                pa = self.store["payment_auth"].get(c["id"])
                self._one = (
                    c["id"], c["status"], c["approved_amount"], c["household_id"],
                    h["household_ref"] if h else None,
                    h["bank_details_ciphertext"] if h else None,
                    h["bank_account_last4"] if h else None,
                    c.get("citizen_mobile_plain"),
                    pa.get("ds_authorized_at") if pa else None,
                )
        elif s.startswith("UPDATE cases SET status"):
            # Written only on the FIRST authorisation. Applying it for real, rather than
            # swallowing it, is what lets a test assert the case actually reached
            # "Payment Processed" — a fake that ignored the write would pass either way.
            new_status, case_id = params
            for c in self.store["cases"].values():
                if c["id"] == case_id:
                    c["status"] = new_status
            self._one = None
        # --- statements issued by the notification chain (notify_status_change_all) -----------
        # Push short-circuits on missing VAPID keys before querying, so only the email and SMS
        # lookups reach here. Both resolve to "nobody to tell" in this fixture, which is the
        # honest state: no household in it carries a contact_email or a plaintext mobile.
        # Notification CONTENT is covered properly in tests/test_notification_channels.py.
        elif "h.contact_email" in s:
            (case_id,) = params
            c = next((c for c in self.store["cases"].values() if c["id"] == case_id), None)
            h = self.store["households"].get(c["household_id"]) if c else None
            self._one = ((h or {}).get("contact_email"), c.get("locale", "si")) if c else None
        elif "SELECT c.household_id, c.locale" in s:
            (case_id,) = params
            c = next((c for c in self.store["cases"].values() if c["id"] == case_id), None)
            self._one = (c["household_id"], c.get("locale", "si")) if c else None
        elif "FROM push_subscriptions" in s:
            self._rows = []
        elif s.startswith("UPDATE payment_authorizations"):
            ds_by, household_id, last4, case_id = params
            auth = self.store["payment_auth"].get(case_id)
            if not auth:
                self._one = None
            else:
                auth["ds_authorized_by"] = ds_by
                auth["ds_authorized_at"] = datetime(2026, 8, 26, 12, 0)
                auth["household_id"] = auth.get("household_id") or household_id
                auth["bank_account_last4"] = auth.get("bank_account_last4") or last4
                auth["reveals"] = auth.get("reveals", 0) + 1
                self._one = (auth["id"], auth["amount_lkr"], auth["ds_authorized_at"])
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

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
    ciphertext, last4 = encrypt_bank_details(DETAILS, BANK_KEY)
    return {
        "cases": {
            "HEC-2026-0001": {"id": 1, "status": "Approved", "approved_amount": 40000,
                              "household_id": 1, "ds_division_id": THALAWA},
            "HEC-2026-0002": {"id": 2, "status": "Submitted", "approved_amount": None,
                              "household_id": 1, "ds_division_id": THALAWA},
            "HEC-2026-0003": {"id": 3, "status": "Approved", "approved_amount": 10000,
                              "household_id": 2, "ds_division_id": THALAWA},
            "HEC-2026-0004": {"id": 4, "status": "Approved", "approved_amount": 5000,
                              "household_id": None, "ds_division_id": THALAWA},
            "HEC-2026-0009": {"id": 9, "status": "Approved", "approved_amount": 1000,
                              "household_id": 1, "ds_division_id": KEKIRAWA},
        },
        "households": {
            1: {"household_ref": "HH-2026-0001", "bank_details_ciphertext": ciphertext,
                "bank_account_last4": last4},
            2: {"household_ref": "HH-2026-0002", "bank_details_ciphertext": None,
                "bank_account_last4": None},
        },
        "payment_auth": {
            1: {"id": 11, "amount_lkr": 40000},
            3: {"id": 13, "amount_lkr": 10000},
            4: {"id": 14, "amount_lkr": 5000},
            9: {"id": 19, "amount_lkr": 1000},
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


def _post(client, canonical="HEC-2026-0001", **kw):
    return client.post(f"/api/v1/ds/cases/{canonical}/authorize-payment", headers=_auth(**kw))


# --------------------------------------------------------------------- happy path
def test_reveals_the_full_account_number_and_records_the_authorisation(client, store):
    res = _post(client)
    assert res.status_code == 200
    body = res.get_json()
    assert body["bank_details"]["account_number"] == "8001234567890"
    assert body["household_ref"] == "HH-2026-0001"
    assert body["amount_lkr"] == 40000
    assert store["payment_auth"][1]["ds_authorized_by"] == "ds-1"
    assert store["payment_auth"][1]["bank_account_last4"] == "7890"


def test_a_repeat_call_re_reveals_without_creating_a_second_authorisation(client, store):
    """An officer who closed the window needs the number back; the state must not double."""
    first = _post(client)
    second = _post(client)
    assert first.status_code == second.status_code == 200
    assert second.get_json()["bank_details"]["account_number"] == "8001234567890"
    assert len(store["payment_auth"]) == 4  # unchanged
    assert store["payment_auth"][1]["reveals"] == 2


def test_every_reveal_is_audit_logged(client, store):
    _post(client)
    _post(client)
    reveals = [a for a in store["audit"] if a["event"] == "ds_authorized_payment"]
    assert len(reveals) == 2
    assert reveals[0]["actor_id"] == "ds-1"
    assert reveals[0]["case_id"] == 1


def test_the_audit_log_records_that_a_reveal_happened_never_what_was_revealed(client, store):
    _post(client)
    entry = [a for a in store["audit"] if a["event"] == "ds_authorized_payment"][0]
    metadata = json.loads(entry["metadata"])
    assert metadata["bank_account_last4"] == "7890"
    assert metadata["household_ref"] == "HH-2026-0001"
    # The account number itself must never reach the audit trail.
    assert "8001234567890" not in entry["metadata"]
    assert "Bank of Ceylon" not in entry["metadata"]


# --------------------------------------------------------------------- refusals are distinct
def test_a_case_in_another_division_is_a_404_not_a_403(client):
    """A distinct 403 would confirm that a case exists outside this officer's division."""
    res = _post(client, canonical="HEC-2026-0009")
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_an_unknown_case_is_also_a_404(client):
    assert _post(client, canonical="HEC-2026-9999").status_code == 404


def test_an_unapproved_case_cannot_be_paid(client, store):
    """The DWC administrator approves; the DS office pays. Paying before approval bypasses the
    human decision NFR-6.1 requires."""
    res = _post(client, canonical="HEC-2026-0002")
    assert res.status_code == 409
    assert res.get_json()["error"] == "not_approved"
    assert res.get_json()["status"] == "Submitted"


def test_a_household_with_no_bank_details_is_reported_as_such(client):
    res = _post(client, canonical="HEC-2026-0003")
    assert res.status_code == 409
    body = res.get_json()
    assert body["error"] == "no_bank_details"
    # Named, so the DS officer knows which family to ask.
    assert body["household_ref"] == "HH-2026-0002"


def test_a_case_with_no_household_cannot_be_paid(client):
    """Pre-Epic-8 and seeded cases. There is no registered family to pay."""
    res = _post(client, canonical="HEC-2026-0004")
    assert res.status_code == 409
    assert res.get_json()["error"] == "no_household"


def test_unreadable_ciphertext_is_distinct_from_no_details_on_file(client, store):
    """Telling the officer the family gave no account when the key actually changed would send
    them to collect details the family already gave."""
    store["households"][1]["bank_details_ciphertext"] = "not-a-valid-fernet-token"
    res = _post(client)
    assert res.status_code == 500
    assert res.get_json()["error"] == "bank_details_unreadable"


def test_no_key_configured_fails_closed(nokey_client):
    res = nokey_client.post(
        "/api/v1/ds/cases/HEC-2026-0001/authorize-payment", headers=_auth()
    )
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


# --------------------------------------------------------------------- auth
def test_requires_a_ds_officer(client):
    for role in ("officer", "admin", "system_admin", None):
        assert _post(client, role=role).status_code == 403


def test_requires_a_token(client):
    assert client.post("/api/v1/ds/cases/HEC-2026-0001/authorize-payment").status_code == 401


def test_a_ds_officer_with_no_division_is_refused(client):
    assert _post(client, division=None).status_code == 403


# --------------------------------------------------------------------- the platform guarantee
def test_exactly_one_call_site_decrypts_bank_details():
    """THE boundary this story exists to draw. Every call site of decrypt_bank_details is a place
    a citizen's account number becomes readable, so the SET of call sites is itself a security
    property — and it is asserted here rather than left to review discipline.

    If this fails, a new surface has gained the ability to read account numbers. Adding one is a
    decision, not an implementation detail: update this test deliberately, with a reason.
    """
    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    call_sites = []
    for path in app_dir.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), 1):
            # The definition and the import inside bank_crypto itself are not call sites.
            if re.search(r"\bdecrypt_bank_details\s*\(", line) and "def " not in line:
                rel = path.relative_to(app_dir).as_posix()
                if rel != "infrastructure/security/bank_crypto.py":
                    call_sites.append(f"{rel}:{i}")

    assert len(call_sites) == 1, (
        "bank details must be decrypted in exactly one place; found: " + str(call_sites)
    )
    assert call_sites[0].startswith("api/v1/ds.py"), (
        "the only decrypt site must be the DS payment authorisation; found: " + call_sites[0]
    )


def test_no_read_endpoint_selects_the_bank_ciphertext():
    """The companion guarantee: nothing but the payment path may even SELECT the column.

    A surface that never decrypts but returns the ciphertext would still be handing out an offline
    target — and the officer, admin, citizen, public-status and research paths have no reason to
    read it at all.
    """
    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    offenders = []
    for path in app_dir.rglob("*.py"):
        rel = path.relative_to(app_dir).as_posix()
        if rel in ("api/v1/ds.py", "api/v1/households.py",
                   "infrastructure/security/bank_crypto.py"):
            continue  # ds.py reads it to decrypt; households.py writes it at registration
        if "bank_details_ciphertext" in path.read_text(encoding="utf-8"):
            offenders.append(rel)

    assert offenders == [], (
        "bank_details_ciphertext is referenced outside the payment/registration paths: "
        + str(offenders)
    )


# ============================================================ the citizen is told by whoever pays
#
# WHY THESE EXIST. "Payment Processed" could previously be set only by the DWC administrator's
# mark_paid action. But the administrator does not disburse -- the DS office does, and it is the
# only role that can decrypt an account number. So the citizen's "you have been paid" message
# depended on a phone call between two organisations that the software could not see, and never
# arrived at all if nobody made that call. Releasing the account number IS the disbursement
# decision, so it is the event that now announces itself.

def _events(store):
    return [entry["event"] for entry in store["audit"]]


def test_authorising_payment_moves_the_case_to_paid(client, store):
    assert store["cases"]["HEC-2026-0001"]["status"] == "Approved"
    assert _post(client).status_code == 200
    assert store["cases"]["HEC-2026-0001"]["status"] == "Payment Processed"


def test_authorising_payment_records_the_paid_event_against_the_ds_officer(client, store):
    """The audit trail must name the office that actually paid, not the one that approved."""
    _post(client)
    paid = [e for e in store["audit"] if e["event"] == "case_paid"]
    assert len(paid) == 1
    assert paid[0]["actor_id"] == "ds-1"
    assert json.loads(paid[0]["metadata"])["authorized_by"] == "ds_officer"


def test_a_repeat_reveal_does_not_announce_the_payment_twice(client, store):
    """The endpoint re-reveals on purpose. Re-announcing would tell a citizen twice."""
    _post(client)
    _post(client)
    assert len([e for e in _events(store) if e == "case_paid"]) == 1


def test_a_repeat_reveal_still_returns_the_account_number(client):
    """REGRESSION GUARD. Moving the case off "Approved" on the first call made the status guard
    reject every later call with 409, silently breaking the re-reveal this endpoint promises in
    its own docstring -- locking an officer out of the number mid-payment."""
    first = _post(client)
    second = _post(client)
    assert first.status_code == second.status_code == 200
    assert second.get_json()["bank_details"]["account_number"] == \
        first.get_json()["bank_details"]["account_number"]


def test_a_case_the_administrator_already_marked_paid_is_not_re_announced(client, store):
    """mark_paid stays available on the admin side and notifies when used. A DS officer opening
    that case afterwards needs the account number, but the citizen has already been told."""
    store["cases"]["HEC-2026-0001"]["status"] = "Payment Processed"
    assert _post(client).status_code == 200
    assert "case_paid" not in _events(store)


def test_an_unapproved_case_is_still_refused(client, store):
    """Widening the guard to admit "Payment Processed" must not admit everything else."""
    res = _post(client, canonical="HEC-2026-0002")  # Submitted
    assert res.status_code == 409
    assert res.get_json()["error"] == "not_approved"
    assert store["cases"]["HEC-2026-0002"]["status"] == "Submitted"


def test_a_refused_authorisation_moves_no_status(client, store):
    _post(client, canonical="HEC-2026-0004")  # Approved but no household
    assert store["cases"]["HEC-2026-0004"]["status"] == "Approved"
    assert "case_paid" not in _events(store)
