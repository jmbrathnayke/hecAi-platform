"""Staff account provisioning (FR-11).

THE THREAT THIS MODULE DEFENDS AGAINST, stated so the tests can be read against it: every other
API on the platform acts WITHIN a role. This one ASSIGNS a role, so a defect here does not leak
data — it manufactures the authority to take it. A district administrator who could reach these
endpoints could mint a second administrator over another district; a citizen who could would own
the platform.

Most of what follows therefore tests refusals rather than the happy path.
"""
import json

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
SUPABASE = "https://project.supabase.co"
SERVICE_KEY = "service-role-key-not-real"

SYS_ADMIN_ID = "11111111-1111-1111-1111-111111111111"
OTHER_ID = "22222222-2222-2222-2222-222222222222"

ANURADHAPURA = "අනුරාධපුරය"
THALAWA = "තලාව"
AMBALANTOTA = "අම්බලන්තොට"


def _token(sub=SYS_ADMIN_ID, role="system_admin"):
    meta = {"role": role} if role else {}
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload


class FakeCursor:
    """Only the audit write reaches the database from this module."""

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
            self._one = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        elif s.startswith("INSERT INTO audit_log"):
            self.store["audit"].append({"case_id": params[0], "event": params[1],
                                        "actor_id": params[2], "metadata": params[3],
                                        "hash": params[5]})
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
    return {"audit": [], "calls": []}


@pytest.fixture
def app():
    return create_app({
        "TESTING": True, "DATABASE_URL": "postgresql://fake",
        "SUPABASE_JWT_SECRET": SECRET,
        "SUPABASE_URL": SUPABASE, "SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY,
    })


@pytest.fixture
def client(app, store, monkeypatch):
    monkeypatch.setattr("app.api.v1.users._get_connection", lambda: FakeConn(store))

    def record(method):
        def call(url, headers=None, json=None, params=None, timeout=None):
            store["calls"].append({"method": method, "url": url, "json": json})
            if method == "POST":
                return FakeResponse(201, {"id": OTHER_ID, "email": (json or {}).get("email"),
                                          "app_metadata": (json or {}).get("app_metadata")})
            if method == "PUT":
                return FakeResponse(200, {"id": OTHER_ID, "email": "x@example.lk",
                                          "app_metadata": (json or {}).get("app_metadata")})
            if method == "DELETE":
                return FakeResponse(200, {})
            page = (params or {}).get("page", 1)
            if page > 1:
                return FakeResponse(200, {"users": []})
            return FakeResponse(200, {"users": [
                {"id": SYS_ADMIN_ID, "email": "sys@example.lk",
                 "app_metadata": {"role": "system_admin"}},
                {"id": OTHER_ID, "email": "admin@example.lk",
                 "app_metadata": {"role": "admin", "district_id": ANURADHAPURA}},
                {"id": "33333333-3333-3333-3333-333333333333", "email": "citizen@example.lk",
                 "app_metadata": {}},
            ]})

        return call

    for verb in ("get", "post", "put", "delete"):
        monkeypatch.setattr(f"app.api.v1.users.requests.{verb}", record(verb.upper()))
    return app.test_client()


def events(store):
    return [e["event"] for e in store["audit"]]


# ============================================================ the escalation boundary
@pytest.mark.parametrize("role", ["admin", "officer", "ds_officer", None])
def test_only_a_system_admin_may_reach_provisioning(client, role, store):
    """A district administrator who could provision would be able to mint a second administrator
    over a district they do not oversee. That is privilege escalation wearing a feature's clothes."""
    for method, path in [("get", "/api/v1/users"), ("post", "/api/v1/users"),
                         ("patch", f"/api/v1/users/{OTHER_ID}"),
                         ("delete", f"/api/v1/users/{OTHER_ID}")]:
        res = getattr(client, method)(path, json={}, headers=_auth(role=role))
        assert res.status_code == 403, f"{method} {path} admitted role={role}"
    assert store["audit"] == []


def test_provisioning_requires_a_token(client):
    assert client.get("/api/v1/users").status_code == 401


@pytest.mark.parametrize("role", ["superuser", "root", "", "Admin", "system-admin", None, 7])
def test_an_unrecognised_role_is_refused(client, role, store):
    """An arbitrary string written into app_metadata matches no guard, producing an account that
    signs in and can do nothing — which reads as a platform bug, not a typo."""
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "x@example.lk", "role": role, "district_id": ANURADHAPURA})
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_role"
    assert store["calls"] == []  # nothing reached Supabase


# ============================================================ scope validation
def test_an_administrator_needs_a_real_district(client):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "a@example.lk", "role": "admin",
                            "district_id": "Anuradhapura"})  # Latin script, not the reference value
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_scope"


def test_a_ds_officer_needs_a_real_division(client):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "d@example.lk", "role": "ds_officer",
                            "ds_division": "Nowhere"})
    assert res.status_code == 400


def test_an_officer_needs_at_least_one_division(client):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "o@example.lk", "role": "officer",
                            "assigned_divisions": []})
    assert res.status_code == 400


def test_an_officers_divisions_are_each_validated(client):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "o@example.lk", "role": "officer",
                            "assigned_divisions": [THALAWA, "Nowhere"]})
    assert res.status_code == 400


def test_a_valid_administrator_is_created_with_the_district_claim(client, store):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "a@example.lk", "role": "admin",
                            "district_id": ANURADHAPURA})
    assert res.status_code == 201
    sent = store["calls"][-1]["json"]
    assert sent["app_metadata"] == {"role": "admin", "district_id": ANURADHAPURA}
    assert sent["email_confirm"] is True  # no outbound mail exists to confirm through


def test_duplicate_divisions_are_collapsed(client, store):
    client.post("/api/v1/users", headers=_auth(),
                json={"email": "o@example.lk", "role": "officer",
                      "assigned_divisions": [THALAWA, THALAWA, AMBALANTOTA]})
    assert store["calls"][-1]["json"]["app_metadata"]["assigned_divisions"] == [THALAWA, AMBALANTOTA]


# ============================================================ lockout prevention
def test_a_system_admin_cannot_demote_themselves(client, store):
    """There is no second way back in: app_metadata is not writable from the Supabase dashboard,
    so the last system administrator demoting themselves strands the deployment."""
    res = client.patch(f"/api/v1/users/{SYS_ADMIN_ID}", headers=_auth(),
                       json={"role": "admin", "district_id": ANURADHAPURA})
    assert res.status_code == 409
    assert res.get_json()["error"] == "cannot_demote_self"
    assert store["calls"] == []


def test_a_system_admin_cannot_delete_themselves(client, store):
    res = client.delete(f"/api/v1/users/{SYS_ADMIN_ID}", headers=_auth())
    assert res.status_code == 409
    assert res.get_json()["error"] == "cannot_delete_self"
    assert store["calls"] == []


def test_a_system_admin_may_still_update_their_own_scope(client):
    """Refusing self-demotion must not refuse every self-edit."""
    res = client.patch(f"/api/v1/users/{SYS_ADMIN_ID}", headers=_auth(),
                       json={"role": "system_admin"})
    assert res.status_code == 200


# ============================================================ what the API discloses
def test_the_list_shows_staff_only_not_citizens(client):
    """Citizens hold no role claim. Listing them would turn a provisioning screen into a citizen
    directory, which is a different thing with different consent behind it."""
    body = client.get("/api/v1/users", headers=_auth()).get_json()
    assert body["total"] == 2
    assert all(u["role"] for u in body["users"])
    assert not any("citizen@" in (u["email"] or "") for u in body["users"])


def test_the_temporary_password_is_returned_once_and_never_audited(client, store):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": "a@example.lk", "role": "admin",
                            "district_id": ANURADHAPURA})
    password = res.get_json()["temporary_password"]
    assert len(password) >= 16
    assert password not in json.dumps(store["audit"])


def test_no_audit_row_carries_an_email_address(client, store):
    """audit_log is append-only and read by every administrator through the AuditTrail UI. The
    account id traces the action; the address adds an identifier that cannot later be withdrawn."""
    client.post("/api/v1/users", headers=_auth(),
                json={"email": "person@example.lk", "role": "admin", "district_id": ANURADHAPURA})
    assert "person@example.lk" not in json.dumps(store["audit"])


# ============================================================ audit
def test_creating_an_account_is_audit_logged_against_the_actor(client, store):
    client.post("/api/v1/users", headers=_auth(),
                json={"email": "a@example.lk", "role": "admin", "district_id": ANURADHAPURA})
    assert events(store) == ["staff_account_created"]
    entry = store["audit"][-1]
    assert entry["actor_id"] == SYS_ADMIN_ID
    assert entry["case_id"] is None  # provisioning is not an action on a case
    assert json.loads(entry["metadata"])["role"] == "admin"


def test_updating_and_deleting_are_audit_logged(client, store):
    client.patch(f"/api/v1/users/{OTHER_ID}", headers=_auth(),
                 json={"role": "ds_officer", "ds_division": AMBALANTOTA})
    client.delete(f"/api/v1/users/{OTHER_ID}", headers=_auth())
    assert events(store) == ["staff_account_updated", "staff_account_deleted"]


def test_a_refused_request_writes_no_audit_row(client, store):
    client.post("/api/v1/users", headers=_auth(), json={"email": "a@example.lk", "role": "root"})
    assert store["audit"] == []


# ============================================================ configuration and provider failures
def test_provisioning_refuses_when_the_service_key_is_absent(app, store, monkeypatch):
    """Without the key app_metadata cannot be written at all. Refusing is honest; proceeding would
    create an account with no role, which looks like success and is not."""
    app.config["SUPABASE_SERVICE_ROLE_KEY"] = None
    monkeypatch.setattr("app.api.v1.users._get_connection", lambda: FakeConn(store))
    res = app.test_client().get("/api/v1/users", headers=_auth())
    assert res.status_code == 503
    assert res.get_json()["error"] == "provisioning_unavailable"


def test_a_duplicate_email_is_reported_as_a_conflict(app, store, monkeypatch):
    monkeypatch.setattr("app.api.v1.users._get_connection", lambda: FakeConn(store))
    monkeypatch.setattr("app.api.v1.users.requests.post",
                        lambda *a, **k: FakeResponse(422, {"msg": "already registered"}))
    res = app.test_client().post("/api/v1/users", headers=_auth(),
                                 json={"email": "a@example.lk", "role": "admin",
                                       "district_id": ANURADHAPURA})
    assert res.status_code == 409
    assert res.get_json()["error"] == "email_already_exists"
    assert store["audit"] == []


def test_an_unreachable_provider_is_a_502_not_a_500(app, store, monkeypatch):
    import requests as real_requests
    monkeypatch.setattr("app.api.v1.users._get_connection", lambda: FakeConn(store))

    def boom(*a, **k):
        raise real_requests.RequestException("network down")

    monkeypatch.setattr("app.api.v1.users.requests.get", boom)
    res = app.test_client().get("/api/v1/users", headers=_auth())
    assert res.status_code == 502


def test_a_malformed_account_id_is_refused_before_any_call(client, store):
    res = client.delete("/api/v1/users/not-a-uuid", headers=_auth())
    assert res.status_code == 400
    assert store["calls"] == []


@pytest.mark.parametrize("email", ["", "no-at-sign", "a@b", "a b@example.lk", None])
def test_a_malformed_email_is_refused(client, email):
    res = client.post("/api/v1/users", headers=_auth(),
                      json={"email": email, "role": "admin", "district_id": ANURADHAPURA})
    assert res.status_code == 400


# ============================================================ the factory, not the fixture
#
# WHY THIS TEST EXISTS. Every test above builds the app with create_app({... "SUPABASE_URL": ...}),
# injecting the config directly. That made the whole suite pass while the real application factory
# never read SUPABASE_URL from the environment at all — it existed only as a local used to derive
# the JWKS URL and the issuer — so `current_app.config["SUPABASE_URL"]` was None in production and
# the API answered "provisioning is not configured" on a correctly configured machine.
#
# A fixture that supplies what the code under test is supposed to obtain for itself cannot detect
# that the code never obtains it. This asserts against the factory instead.
def test_the_app_factory_reads_the_provisioning_credentials_from_the_environment(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")

    built = create_app()

    assert built.config["SUPABASE_URL"] == "https://example.supabase.co"
    assert built.config["SUPABASE_SERVICE_ROLE_KEY"] == "service-role-key"


def test_a_plaintext_supabase_url_stops_the_app_from_starting(monkeypatch):
    """SUPABASE_URL passes through _https_url(), so provisioning inherits its scheme check.

    That check RAISES rather than returning None — the application refuses to start at all rather
    than running with a plaintext identity host. Stronger than degrading quietly, and the right
    behaviour here: the service-role key is the credential that would travel to that host.
    """
    monkeypatch.setenv("SUPABASE_URL", "http://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")

    with pytest.raises(ValueError, match="must be an https"):
        create_app()


# ============================================================ the form needs a vocabulary
#
# The scope fields were free text at first. A system administrator typed "Polonnaruwa" into the DS
# division field and was refused — correctly, since the reference names are Sinhala and that one is
# a district, not a division. The validation was right and the form was wrong: with 167 divisions
# in a script the keyboard may not be set to, the only feedback on a scope was a rejection after
# submitting. The list response now ships the vocabulary so the form can offer pickers.
def test_the_list_ships_the_district_and_division_vocabularies(client):
    body = client.get("/api/v1/users", headers=_auth()).get_json()

    assert len(body["districts"]) >= 20
    assert ANURADHAPURA in body["districts"]

    divisions = body["divisions"]
    assert len(divisions) > 150
    names = {d["name"] for d in divisions}
    assert THALAWA in names
    assert AMBALANTOTA in names
    # A district name is NOT a division name — the exact confusion the picker prevents.
    assert "Polonnaruwa" not in names


def test_every_division_carries_its_district(client):
    """Several divisions share a name with their district; without the district beside it the
    picker cannot tell them apart."""
    divisions = client.get("/api/v1/users", headers=_auth()).get_json()["divisions"]
    assert all(d.get("name") and d.get("district") for d in divisions)
    thalawa = next(d for d in divisions if d["name"] == THALAWA)
    assert thalawa["district"] == ANURADHAPURA
