"""Fixtures for the real-database scenario suite (Story 7.4).

WHY A SEPARATE ENV VAR. CI runs a bare `pytest -v` from backend/ with no database service
(.github/workflows/backend-ci.yml), and pytest collects everything under tests/. Gating on
DATABASE_URL would be wrong twice over: it is often set from a developer's .env, so the suite
would silently start writing to whatever that points at, and CI could not distinguish "no DB" from
"DB deliberately withheld". HEC_SCENARIO_DB_URL must be set on purpose, by someone who means it.

CLEANUP AND THE HASH CHAIN. These scenarios create real cases through the real routes, so they
also create real hash-chained audit rows. Teardown removes them under the SAME contiguous-tail
rule clear_research_data.py enforces, inside ONE explicit transaction holding the audit advisory
lock, and re-verifies the chain before committing. If the chain would break, the transaction
rolls back and the rows stay put rather than the tamper-evidence the admin UI reports on being
silently corrupted.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

SCENARIO_DB_URL = os.getenv("HEC_SCENARIO_DB_URL")

# Local to the suite; the app is configured with this same value so its verification succeeds.
SCENARIO_JWT_SECRET = "scenario-suite-secret-0123456789-abcdefgh"

OFFICER_SUB = "scenario-officer-0000-0000-000000000001"
CITIZEN_SUB = "scenario-citizen-0000-0000-000000000002"
ADMIN_SUB = "scenario-admin-0000-0000-000000000003"
RESEARCHER_SUB = "scenario-research-0000-0000-00000000004"

# Must be a district the compensation model knows AND the one the admin token is scoped to,
# or post_case_action's `WHERE district = %s` finds nothing and every approve scenario 404s.
SCENARIO_DISTRICT = "අනුරාධපුරය"
SCENARIO_DIVISION = "ඉපලෝගම"


def make_token(sub, role=None, district_id=None, expires_in=3600, assigned_divisions=None):
    metadata = {}
    if role:
        metadata["role"] = role
    if district_id:
        metadata["district_id"] = district_id
    if assigned_divisions:
        metadata["assigned_divisions"] = assigned_divisions
    payload = {
        "sub": sub,
        "app_metadata": metadata,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
    }
    return jwt.encode(payload, SCENARIO_JWT_SECRET, algorithm="HS256")


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def scenario_app():
    from app import create_app

    return create_app({
        "TESTING": True,
        "DATABASE_URL": SCENARIO_DB_URL,
        "SUPABASE_JWT_SECRET": SCENARIO_JWT_SECRET,
    })


@pytest.fixture(scope="session")
def client(scenario_app):
    return scenario_app.test_client()


@pytest.fixture(scope="session")
def tokens():
    return {
        "officer": make_token(OFFICER_SUB, role="officer",
                              assigned_divisions=[SCENARIO_DIVISION]),
        "citizen": make_token(CITIZEN_SUB),
        "admin": make_token(ADMIN_SUB, role="admin", district_id=SCENARIO_DISTRICT),
        "researcher": make_token(RESEARCHER_SUB, role="system_admin"),
    }


@pytest.fixture(scope="session")
def db():
    """Autocommit, because the scenarios read state the ROUTES committed on their own
    connections. Teardown deliberately turns it off — see _purge."""
    import psycopg2

    conn = psycopg2.connect(SCENARIO_DB_URL, connect_timeout=45)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def created(db):
    """Collects every offline_id a scenario creates, then purges them at session end."""
    ids = []
    yield ids
    _purge(db, ids)


@pytest.fixture
def new_offline_id(created):
    """A fresh UUID already registered for teardown, so a failing test still cleans up."""
    def _make():
        oid = str(uuid.uuid4())
        created.append(oid)
        return oid
    return _make


def _purge(conn, offline_ids):
    """Remove everything the session created, atomically.

    ATOMICITY IS THE POINT. The first version ran the five DELETEs on the session's autocommit
    connection and only then called verify_chain — so by the time it raised "the chain is
    invalid", the rows were already durably gone and there was nothing left to roll back. Its
    docstring promised the opposite. The deletes now run in one explicit transaction with the
    same advisory lock write_audit_log() takes, so a concurrent submission cannot chain onto a
    row this transaction is removing, and any failure (or a broken post-check) rolls the whole
    thing back.
    """
    from app.infrastructure.audit import _AUDIT_CHAIN_LOCK_KEY, verify_chain

    if not offline_ids:
        return

    conn.autocommit = False
    try:
        _purge_in_transaction(conn, offline_ids, _AUDIT_CHAIN_LOCK_KEY, verify_chain)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.autocommit = True


def _purge_in_transaction(conn, offline_ids, lock_key, verify_chain):
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key,))
        # ::uuid[] is required, not cosmetic. cases.offline_id is a UUID column (migration 002)
        # and psycopg2 adapts a Python list of strings to a text[], so an uncast ANY() fails with
        # "operator does not exist: uuid = text" — which surfaces only at session teardown, long
        # after the tests themselves have passed.
        cur.execute("SELECT id FROM cases WHERE offline_id = ANY(%s::uuid[])", (offline_ids,))
        case_ids = [r[0] for r in cur.fetchall()]

        # No early return on an empty case_ids. A run where every submit 403s (e.g. `-k` selecting
        # only the mismatched-officer_id test) still writes case-less audit rows through the
        # export and verify-chain calls; returning here would strand them in the chain forever
        # and make every later clear refuse.

        # Two sources, and the second is not optional: several endpoints write audit rows with
        # case_id IS NULL — `admin_verified_chain` from the verify-chain call in scenario 6, and
        # `research_exported_data` from the export in scenario 5. Matching on case_id alone
        # leaves those unattributed, the contiguous-tail check then sees them as foreign rows
        # sitting among ours, and teardown refuses. (It really did, the first time this ran.)
        # Every scenario actor id starts with "scenario-", which makes them precisely
        # identifiable without guessing from timestamps.
        # ::bigint[] so an empty case_ids list is a typed empty array rather than an untyped
        # '{}', which Postgres rejects with "operator does not exist: bigint = text".
        cur.execute(
            "SELECT id FROM audit_log WHERE case_id = ANY(%s::bigint[]) "
            "OR actor_id LIKE 'scenario-%%' ORDER BY id",
            (case_ids,),
        )
        audit_ids = [r[0] for r in cur.fetchall()]

        if audit_ids:
            cur.execute(
                "SELECT id FROM audit_log WHERE id > %s AND NOT (id = ANY(%s))",
                (min(audit_ids), audit_ids),
            )
            intruders = [r[0] for r in cur.fetchall()]
            if intruders:
                raise RuntimeError(
                    f"Scenario teardown refused: {len(intruders)} non-scenario audit row(s) "
                    f"({intruders[:5]}) were written after the scenario's first one. Deleting "
                    "would break the hash chain. Scenario rows left in place — remove them "
                    "manually once you understand what else wrote to this database."
                )

        if case_ids:
            cur.execute("DELETE FROM payment_authorizations WHERE case_id = ANY(%s)", (case_ids,))
            cur.execute("DELETE FROM inference_log WHERE case_id = ANY(%s)", (case_ids,))
            cur.execute("DELETE FROM compensation_estimates WHERE case_id = ANY(%s)", (case_ids,))
        if audit_ids:
            cur.execute("DELETE FROM audit_log WHERE id = ANY(%s)", (audit_ids,))
        if case_ids:
            cur.execute("DELETE FROM cases WHERE id = ANY(%s)", (case_ids,))

        valid, broken = verify_chain(cur)
        if not valid:
            raise RuntimeError(
                f"Scenario teardown broke the audit chain at row id={broken}. The "
                "contiguous-tail check passed but the chain is invalid — investigate before "
                "running this suite again."
            )


def case_payload(offline_id, **overrides):
    """The real POST /api/v1/cases/submit body shape. district/ds_division are set by default
    because a case with no district is invisible to every admin (Story 5.3's documented MVP
    limitation) and would make the approve scenario 404."""
    payload = {
        "offline_id": offline_id,
        "damage_category": "property",
        "district": SCENARIO_DISTRICT,
        "ds_division": SCENARIO_DIVISION,
        "ai_severity": "Moderate",
        "locale": "si",
    }
    payload.update(overrides)
    return payload
