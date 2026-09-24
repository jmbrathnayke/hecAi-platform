"""GET /api/v1/notifications/feed — the in-app bell.

WHAT THIS HAS TO PROVE, beyond "it returns rows":

  1. **The feed is scoped from the token, never from the request.** An officer sees their assigned
     divisions, an administrator their district, a citizen their own household. A caller who could
     widen their own feed would be reading case references for areas they have no authority over,
     which is the same failure the push-subscription route was rewritten to close (migration 032).
  2. **It works with no push subscriptions at all.** The feed reads the audit rows the push path
     writes, and `staff_push_skipped_no_subscription` is written precisely when nobody was
     subscribed. If the feed only worked once someone had granted the browser prompt it would be
     useless to the people it exists for.
  3. **It leaks no actor.** Who acted is in the case's own audit trail, which is gated separately.
     A feed is read by every role, citizens included.
"""
import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >= 32 bytes for HS256

GALNEWA = "ගල්නැව"
THALAWA = "තලාව"
ANURADHAPURA = "අනුරාධපුරය"


def _token(sub="staff-1", role="officer", meta=None):
    claims = {"role": role} if role else {}
    claims.update(meta or {})
    return jwt.encode({"sub": sub, "app_metadata": claims}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


class FakeCursor:
    """Records what the route asked for. The assertions are about the WHERE clause's parameters —
    that is where scoping either happens or does not."""

    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        self.store["queries"].append({"sql": s, "params": params})

    def fetchall(self):
        return self.store["rows"]


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
        self.store["closed"] = True


@pytest.fixture
def store():
    return {"queries": [], "rows": [], "closed": False}


@pytest.fixture
def client(store, monkeypatch):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                      "SUPABASE_JWT_SECRET": SECRET})
    monkeypatch.setattr("app.api.v1.notifications._get_connection", lambda: FakeConn(store))
    return app.test_client()


def _last(store):
    return store["queries"][-1]


# --- authentication ------------------------------------------------------------------------------


def test_an_unauthenticated_caller_is_refused(client, store):
    assert client.get("/api/v1/notifications/feed").status_code == 401
    assert store["queries"] == []


def test_a_token_without_a_subject_is_refused(client, store):
    token = jwt.encode({"app_metadata": {"role": "officer"}}, SECRET, algorithm="HS256")
    res = client.get("/api/v1/notifications/feed",
                     headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401
    assert store["queries"] == []


# --- staff scoping -------------------------------------------------------------------------------


def test_an_officer_is_scoped_to_their_assigned_divisions(client, store):
    res = client.get("/api/v1/notifications/feed",
                     headers=_auth(role="officer", meta={"assigned_divisions": [GALNEWA, THALAWA]}))
    assert res.status_code == 200
    params = _last(store)["params"]
    assert params[1] == "officer"
    assert params[2] == [GALNEWA, THALAWA]
    assert "staff" in params[0]  # the staff_push_% family, not the citizen one


def test_an_administrator_is_scoped_to_their_district(client, store):
    client.get("/api/v1/notifications/feed",
               headers=_auth(sub="admin-1", role="admin", meta={"district_id": ANURADHAPURA}))
    params = _last(store)["params"]
    assert (params[1], params[2]) == ("admin", [ANURADHAPURA])


def test_a_ds_officer_is_scoped_to_their_one_division(client, store):
    client.get("/api/v1/notifications/feed",
               headers=_auth(sub="ds-1", role="ds_officer", meta={"ds_division": GALNEWA}))
    params = _last(store)["params"]
    assert (params[1], params[2]) == ("ds_officer", [GALNEWA])


def test_a_staff_account_cannot_widen_its_own_scope_through_the_request(client, store):
    """The scope travels in the signature-verified token. A query string naming another division
    must change nothing — otherwise any officer could read every division's case references."""
    client.get("/api/v1/notifications/feed?scope=" + THALAWA + "&role=admin",
               headers=_auth(role="officer", meta={"assigned_divisions": [GALNEWA]}))
    params = _last(store)["params"]
    assert (params[1], params[2]) == ("officer", [GALNEWA])


@pytest.mark.parametrize("role,meta", [
    ("system_admin", {}),
    ("officer", {}),                      # assigned to nothing yet
    ("officer", {"assigned_divisions": []}),
    ("admin", {"district_id": "   "}),    # whitespace is not a district
    ("ds_officer", {}),
])
def test_a_staff_account_with_no_scope_gets_an_empty_feed_and_a_reason(client, store, role, meta):
    """An empty feed and a broken one must not look the same. `system_admin` holds no area claim and
    no notify_staff_push() call targets that role, so this is its permanent, correct answer."""
    res = client.get("/api/v1/notifications/feed", headers=_auth(role=role, meta=meta))
    assert res.status_code == 200
    body = res.get_json()
    assert body == {"notifications": [], "count": 0, "reason": "no_scope"}
    assert store["queries"] == []  # nothing was asked of the database


# --- citizens ------------------------------------------------------------------------------------


def test_a_citizen_is_scoped_to_their_own_household(client, store):
    client.get("/api/v1/notifications/feed", headers=_auth(sub="citizen-9", role=None))
    q = _last(store)
    assert q["params"][0] == "citizen-9"
    assert "households h" in q["sql"]
    assert "registrant_uid" in q["sql"]


def test_a_citizen_feed_counts_each_status_change_once(client, store):
    """notify_status_change_push() writes exactly one `push_*` row per status change and the email
    that follows writes another row. Matching only the push family counts announcements once."""
    client.get("/api/v1/notifications/feed", headers=_auth(sub="citizen-9", role=None))
    pattern = _last(store)["params"][1]
    assert pattern.startswith("push")
    assert "staff" not in pattern


# --- what comes back -----------------------------------------------------------------------------


def test_rows_are_returned_even_when_nobody_was_subscribed_to_push(client, store):
    """The whole point of the bell: `staff_push_skipped_no_subscription` is written precisely when
    no device was registered, and it is still a record that this division was notified."""
    store["rows"] = [
        (91, "staff_push_skipped_no_subscription", "payment_pending", "HEC-2026-0288", GALNEWA, None),
    ]
    body = client.get("/api/v1/notifications/feed",
                      headers=_auth(role="ds_officer", meta={"ds_division": GALNEWA})).get_json()
    assert body["count"] == 1
    assert body["notifications"][0]["event"] == "staff_push_skipped_no_subscription"
    assert body["notifications"][0]["subject"] == "payment_pending"
    assert body["notifications"][0]["canonical_id"] == "HEC-2026-0288"


def test_no_actor_id_reaches_the_caller(client, store):
    store["rows"] = [(91, "staff_push_sent", "case_submitted", "HEC-2026-0288", GALNEWA, None)]
    body = client.get("/api/v1/notifications/feed",
                      headers=_auth(role="officer",
                                    meta={"assigned_divisions": [GALNEWA]})).get_json()
    item = body["notifications"][0]
    assert set(item) == {"id", "event", "subject", "canonical_id", "scope", "created_at"}
    assert "actor_id" not in item
    # The SELECT must not even fetch it.
    assert "actor_id" not in _last(store)["sql"]


def test_the_newest_row_comes_first_and_the_page_is_capped(client, store):
    client.get("/api/v1/notifications/feed",
               headers=_auth(role="officer", meta={"assigned_divisions": [GALNEWA]}))
    sql = _last(store)["sql"]
    assert "ORDER BY a.id DESC" in sql
    assert "LIMIT" in sql
    from app.api.v1.notifications import MAX_FEED_ROWS
    assert _last(store)["params"][-1] == MAX_FEED_ROWS


def test_a_database_failure_is_a_500_not_a_silently_empty_bell(client, store, monkeypatch):
    import psycopg2

    class Exploding(FakeConn):
        def cursor(self):
            raise psycopg2.OperationalError("connection lost")

    monkeypatch.setattr("app.api.v1.notifications._get_connection", lambda: Exploding(store))
    res = client.get("/api/v1/notifications/feed",
                     headers=_auth(role="officer", meta={"assigned_divisions": [GALNEWA]}))
    assert res.status_code == 500
    assert res.get_json() == {"error": "server_error"}


def test_the_connection_is_closed_even_on_the_happy_path(client, store):
    client.get("/api/v1/notifications/feed",
               headers=_auth(role="officer", meta={"assigned_divisions": [GALNEWA]}))
    assert store["closed"] is True
