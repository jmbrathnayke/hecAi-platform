"""Keep the `users` directory current as people actually use the platform.

WHY THIS EXISTS. Sign-up and sign-in are browser→Supabase calls; the backend never sees them, so
there is no moment during authentication at which a row could be written. What the backend DOES see
is every authenticated API request, carrying a signature-verified JWT with the account's uid, role
and scope already in it. That is the hook: the first request an account makes after signing in
refreshes its row.

*** THIS IS A PROJECTION, NOT AN AUTHORITY, AND IT MUST NEVER FAIL A REQUEST. ***
Authorization reads the role out of the token (middleware/auth.py) and never out of this table. A
row that is missing, stale or wrong grants nothing and withholds nothing. So every failure here --
a dropped connection, a constraint nobody anticipated, the table not existing yet on a deployment
that has not run migration 037 -- is swallowed. A directory is a convenience; refusing a citizen's
claim submission because a bookkeeping write failed would not be.

THROTTLED IN PROCESS. Without this, every request would cost a database round trip on a connection
to us-east-1. A uid seen within TOUCH_INTERVAL_SECONDS is skipped entirely, so a busy session costs
one write rather than one per request. The cache is per worker and per process: losing it on restart
costs one extra write per active account, which is the right way round.

NO PASSWORDS. Supabase holds them hashed, nothing here needs them, and sign-in never consults this
table. See migration 037.
"""
import logging
import threading
import time

import psycopg2
from flask import current_app

logger = logging.getLogger(__name__)

# Long enough that an active session writes once, short enough that the directory is never
# meaningfully behind. A role change takes effect in the token immediately; this is only how
# quickly the *reporting* copy catches up.
TOUCH_INTERVAL_SECONDS = 900  # 15 minutes

# Short: this runs inside a request that is doing real work, and the directory is never worth
# making anyone wait for.
CONNECT_TIMEOUT_SECONDS = 5

_recent: dict[str, float] = {}
_lock = threading.Lock()


def _should_touch(uid: str) -> bool:
    """-> True at most once per uid per interval. Both the read and the write happen under one lock
    so two concurrent requests from the same account cannot both decide to write."""
    now = time.monotonic()
    with _lock:
        last = _recent.get(uid)
        if last is not None and (now - last) < TOUCH_INTERVAL_SECONDS:
            return False
        _recent[uid] = now
        # Bound the cache. A deployment serving thousands of accounts should not accumulate an
        # entry per account forever; dropping the oldest costs one extra write, nothing more.
        if len(_recent) > 5000:
            for stale in sorted(_recent, key=_recent.get)[:1000]:
                _recent.pop(stale, None)
    return True


def _scope_columns(role: str, meta: dict):
    """-> (district_name, ds_division, assigned_divisions) for this role's claim shape.

    Reads app_metadata only, the same claim the guards trust; user_metadata is client-writable.
    A citizen and a system_admin carry no area, which is why all three come back None for them.
    """
    district = meta.get("district_id") if role == "admin" else None
    ds_division = meta.get("ds_division") if role == "ds_officer" else None
    divisions = None
    if role == "officer":
        raw = meta.get("assigned_divisions")
        if isinstance(raw, list):
            divisions = [d for d in raw if isinstance(d, str)]
    return (district if isinstance(district, str) else None,
            ds_division if isinstance(ds_division, str) else None,
            divisions)


def touch(claims) -> None:
    """Refresh this account's directory row. Never raises, never blocks a request meaningfully."""
    try:
        uid = claims.get("sub")
        if not uid or not _should_touch(uid):
            return

        meta = claims.get("app_metadata") or {}
        role = meta.get("role") or "citizen"
        district, ds_division, divisions = _scope_columns(role, meta)
        # The email is in the token for a password/OAuth session. It is not always present -- a
        # token minted from a refresh may omit it -- so COALESCE keeps whatever the sync script or
        # an earlier request already recorded rather than blanking it.
        email = claims.get("email")

        # Skipped under TESTING. The suite drives hundreds of authenticated requests against a
        # placeholder DATABASE_URL, and each one would pay a doomed connection attempt -- it
        # doubled the suite's runtime when this was first wired in. Nothing under test depends on
        # the directory, and touch() is exercised directly by tests/test_user_directory.py.
        if current_app.config.get("TESTING"):
            return

        database_url = current_app.config.get("DATABASE_URL")
        if not database_url:
            return

        conn = psycopg2.connect(database_url, connect_timeout=CONNECT_TIMEOUT_SECONDS)
        try:
            with conn, conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO users (supabase_uid, role, email, district_name, ds_division,
                                          assigned_divisions, last_sign_in_at, synced_at)
                       VALUES (%s, %s, %s, %s, %s, %s, now(), now())
                       ON CONFLICT (supabase_uid) DO UPDATE
                         SET role = EXCLUDED.role,
                             email = COALESCE(EXCLUDED.email, users.email),
                             district_name = EXCLUDED.district_name,
                             ds_division = EXCLUDED.ds_division,
                             assigned_divisions = EXCLUDED.assigned_divisions,
                             last_sign_in_at = now(),
                             synced_at = now()""",
                    (uid, role, email, district, ds_division, divisions),
                )
        finally:
            conn.close()
    except Exception:
        # Deliberately broad, and deliberately silent at info level: this is bookkeeping on the
        # authentication path of a compensation system. Nothing it can go wrong with is worth
        # failing a request over, and nothing it records is worth paging anyone about.
        logger.info("user directory touch skipped", exc_info=True)
