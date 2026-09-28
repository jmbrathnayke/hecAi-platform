"""The `users` directory refresh (app/infrastructure/user_directory.py).

THE CONTRACT THIS PROTECTS. touch() runs on the authentication path of a compensation system, after
the guard has already decided access from the token. It is bookkeeping. So the tests below are
mostly about what it must NOT do: it must not raise, must not slow the request down on every call,
and must not write a credential. The one positive behaviour — that the row carries the role and
scope from the verified claim — matters because that row is what resolves an audit_log.actor_id to
a person.
"""
import time

import psycopg2
import pytest

from app import create_app
from app.infrastructure import user_directory


@pytest.fixture(autouse=True)
def reset_throttle():
    user_directory._recent.clear()
    yield
    user_directory._recent.clear()


@pytest.fixture
def app():
    # Not TESTING: these tests exercise the real path, with the connection faked one level down.
    return create_app({"DATABASE_URL": "postgresql://fake"})


class FakeCursor:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.store.append({"sql": " ".join(sql.split()), "params": params})


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


class Writes(list):
    """The statements touch() issued, plus the connections it opened — a list so the assertions
    read naturally, with `conns` hung off it for the close-the-connection test."""

    def __init__(self):
        super().__init__()
        self.conns = []


@pytest.fixture
def writes(monkeypatch):
    store = Writes()

    def fake_connect(url, **kw):
        conn = FakeConn(store)
        store.conns.append(conn)
        return conn

    monkeypatch.setattr(user_directory.psycopg2, "connect", fake_connect)
    return store


def claims(sub="uid-1", role=None, email="someone@example.lk", **meta):
    app_metadata = dict(meta)
    if role:
        app_metadata["role"] = role
    return {"sub": sub, "email": email, "app_metadata": app_metadata}


# --- it must never raise ------------------------------------------------------------------------


def test_a_database_failure_never_reaches_the_request(app, monkeypatch):
    def explode(*a, **k):
        raise psycopg2.OperationalError("connection refused")

    monkeypatch.setattr(user_directory.psycopg2, "connect", explode)
    with app.app_context():
        user_directory.touch(claims())  # must not raise


def test_a_missing_table_never_reaches_the_request(app, monkeypatch):
    """A deployment that has the code but not migration 037 must keep working."""
    class Missing(FakeConn):
        def cursor(self):
            raise psycopg2.errors.UndefinedTable("relation \"users\" does not exist")

    monkeypatch.setattr(user_directory.psycopg2, "connect", lambda *a, **k: Missing([]))
    with app.app_context():
        user_directory.touch(claims())


@pytest.mark.parametrize("bad", [{}, {"sub": None}, {"sub": ""}])
def test_a_token_without_a_subject_is_ignored(app, writes, bad):
    with app.app_context():
        user_directory.touch(bad)
    assert writes == []


def test_no_database_url_is_a_silent_skip(writes):
    with create_app({"DATABASE_URL": None}).app_context():
        user_directory.touch(claims())
    assert writes == []


def test_nothing_is_written_under_testing(writes):
    """The suite drives hundreds of authenticated requests; each would pay a doomed connection."""
    with create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"}).app_context():
        user_directory.touch(claims())
    assert writes == []


# --- throttling ---------------------------------------------------------------------------------


def test_a_busy_session_costs_one_write_not_one_per_request(app, writes):
    with app.app_context():
        for _ in range(25):
            user_directory.touch(claims(sub="uid-busy"))
    assert len(writes) == 1


def test_a_different_account_is_not_throttled_by_the_first(app, writes):
    with app.app_context():
        user_directory.touch(claims(sub="uid-a"))
        user_directory.touch(claims(sub="uid-b"))
    assert len(writes) == 2


def test_the_throttle_lapses_after_the_interval(app, writes, monkeypatch):
    with app.app_context():
        user_directory.touch(claims(sub="uid-1"))
        base = time.monotonic()
        monkeypatch.setattr(user_directory.time, "monotonic",
                            lambda: base + user_directory.TOUCH_INTERVAL_SECONDS + 1)
        user_directory.touch(claims(sub="uid-1"))
    assert len(writes) == 2


def test_the_throttle_cache_is_bounded(app, writes):
    with app.app_context():
        for i in range(5200):
            user_directory.touch(claims(sub=f"uid-{i}"))
    assert len(user_directory._recent) <= 5000


# --- what the row carries -------------------------------------------------------------------


def test_the_connection_is_closed_even_though_nothing_raised(app, writes):
    with app.app_context():
        user_directory.touch(claims())
    assert writes.conns[0].closed is True


@pytest.mark.parametrize("role,meta,expected", [
    ("admin", {"district_id": "අනුරාධපුරය"}, ("අනුරාධපුරය", None, None)),
    ("ds_officer", {"ds_division": "ගල්නැව"}, (None, "ගල්නැව", None)),
    ("officer", {"assigned_divisions": ["ගල්නැව", "තලාව"]}, (None, None, ["ගල්නැව", "තලාව"])),
    ("citizen", {}, (None, None, None)),
    ("system_admin", {}, (None, None, None)),
])
def test_each_role_projects_the_scope_its_claim_actually_carries(app, writes, role, meta, expected):
    with app.app_context():
        user_directory.touch(claims(role=role, **meta))
    _uid, written_role, _email, district, ds_division, divisions = writes[0]["params"]
    assert written_role == role
    assert (district, ds_division, divisions) == expected


def test_a_scope_claim_belonging_to_another_role_is_not_copied(app, writes):
    """A citizen token carrying a stray district_id must not be recorded as holding a district."""
    with app.app_context():
        user_directory.touch(claims(role="citizen", district_id="අනුරාධපුරය",
                                    ds_division="ගල්නැව"))
    _uid, _role, _email, district, ds_division, divisions = writes[0]["params"]
    assert (district, ds_division, divisions) == (None, None, None)


def test_a_malformed_divisions_claim_is_dropped_not_stored(app, writes):
    with app.app_context():
        user_directory.touch(claims(role="officer", assigned_divisions="ගල්නැව"))
    assert writes[0]["params"][5] is None


def test_no_password_or_token_is_ever_written(app, writes):
    with app.app_context():
        user_directory.touch({**claims(), "password": "hunter2", "access_token": "eyJhbGciOi"})
    blob = repr(writes[0])
    assert "hunter2" not in blob
    assert "eyJhbGciOi" not in blob
    assert "password" not in writes[0]["sql"].lower()


def test_an_absent_email_does_not_blank_the_one_already_recorded(app, writes):
    """A token minted from a refresh can omit the email; the row must keep what it has."""
    with app.app_context():
        user_directory.touch({"sub": "uid-9", "app_metadata": {}})
    assert writes[0]["params"][2] is None
    assert "COALESCE(EXCLUDED.email, users.email)" in writes[0]["sql"]


def test_the_write_is_an_upsert_keyed_on_the_account(app, writes):
    with app.app_context():
        user_directory.touch(claims())
    sql = writes[0]["sql"]
    assert "INSERT INTO users" in sql
    assert "ON CONFLICT (supabase_uid) DO UPDATE" in sql
