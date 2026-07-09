"""Tests for the SHA-256 audit hash-chain (FR-5.5, app/infrastructure/audit.py).

Uses a small in-memory fake table (not the per-endpoint FakeCursor pattern in the other
test files) since these tests need a real SELECT-all-rows-in-order to exercise
verify_chain(), not just capture-the-last-INSERT.
"""
import json

from app.infrastructure import audit


class FakeAuditTable:
    """A minimal in-memory stand-in for the audit_log table, supporting exactly the SQL
    write_audit_log()/verify_chain() issue."""

    def __init__(self):
        self.rows = []  # each: dict with id, case_id, event, actor_id, metadata, created_at, hash, prev_hash
        self.lock_calls = 0
        self._result = None

    def execute(self, sql, params=()):
        if "pg_advisory_xact_lock" in sql:
            self.lock_calls += 1
            self._result = None
        elif "SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1" in sql:
            self._result = (self.rows[-1]["hash"],) if self.rows else None
        elif sql.startswith("INSERT INTO audit_log"):
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.rows.append(
                {
                    "id": len(self.rows) + 1,
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
                    "created_at": created_at,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
            self._result = None
        elif sql.startswith("SELECT id, case_id, event, actor_id, metadata, created_at, hash, prev_hash"):
            self._rows_result = [
                (r["id"], r["case_id"], r["event"], r["actor_id"], r["metadata"], r["created_at"], r["hash"], r["prev_hash"])
                for r in self.rows
            ]
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._result

    def fetchall(self):
        return self._rows_result

    def insert_legacy_row(self, event="submitted", case_id=1, actor_id="officer-1"):
        """Simulates the single real pre-migration-012 row: no hash/prev_hash at all."""
        import datetime
        self.rows.append(
            {
                "id": len(self.rows) + 1,
                "case_id": case_id,
                "event": event,
                "actor_id": actor_id,
                "metadata": None,
                "created_at": datetime.datetime(2026, 7, 7, 18, 1, 24, tzinfo=datetime.timezone.utc),
                "hash": None,
                "prev_hash": None,
            }
        )


def test_first_write_has_no_prev_hash():
    cur = FakeAuditTable()
    audit.write_audit_log(cur, 1, "submitted", "officer-1")
    assert cur.rows[0]["prev_hash"] is None
    assert cur.rows[0]["hash"] is not None


def test_second_write_chains_to_first():
    cur = FakeAuditTable()
    audit.write_audit_log(cur, 1, "submitted", "officer-1")
    audit.write_audit_log(cur, 1, "case_synced", "officer-1")
    assert cur.rows[1]["prev_hash"] == cur.rows[0]["hash"]
    assert cur.rows[1]["hash"] != cur.rows[0]["hash"]


def test_write_takes_the_advisory_lock():
    cur = FakeAuditTable()
    audit.write_audit_log(cur, 1, "submitted", "officer-1")
    assert cur.lock_calls == 1


def test_metadata_round_trips_and_affects_the_hash():
    cur = FakeAuditTable()
    audit.write_audit_log(cur, None, "officer_viewed_cases", "officer-1", {"ip_address": "1.2.3.4"})
    assert cur.rows[0]["metadata"] == {"ip_address": "1.2.3.4"}

    cur2 = FakeAuditTable()
    audit.write_audit_log(cur2, None, "officer_viewed_cases", "officer-1", {"ip_address": "9.9.9.9"})
    # Same event/actor, different metadata -> different hash (metadata is covered by the hash).
    assert cur.rows[0]["hash"] != cur2.rows[0]["hash"]


def test_verify_chain_passes_for_an_untampered_chain():
    cur = FakeAuditTable()
    for i in range(5):
        audit.write_audit_log(cur, i, f"event-{i}", "officer-1")
    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is True
    assert broken_id is None


def test_verify_chain_detects_a_tampered_event_field():
    cur = FakeAuditTable()
    for i in range(3):
        audit.write_audit_log(cur, i, f"event-{i}", "officer-1")
    # Tamper with the middle row's content WITHOUT recomputing its hash — exactly what an
    # attacker with raw UPDATE access (but no way to forge a matching hash) would do.
    cur.rows[1]["event"] = "tampered-event"

    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is False
    assert broken_id == cur.rows[1]["id"]


def test_verify_chain_detects_a_forged_link_that_skips_a_row():
    cur = FakeAuditTable()
    for i in range(3):
        audit.write_audit_log(cur, i, f"event-{i}", "officer-1")
    # Attacker rewrites row 3's prev_hash to point past row 2, trying to splice row 2 out.
    cur.rows[2]["prev_hash"] = cur.rows[0]["hash"]

    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is False
    assert broken_id == cur.rows[2]["id"]


def test_verify_chain_skips_a_legacy_pre_chain_row_without_flagging_it():
    cur = FakeAuditTable()
    cur.insert_legacy_row()  # the real id=1 "submitted" row from before migration 012
    audit.write_audit_log(cur, 2, "case_synced", "officer-1")
    audit.write_audit_log(cur, 2, "sms_submission", "officer-1")

    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is True
    assert broken_id is None
    # The chain proper starts fresh at the first hashed row, not chained to the legacy row.
    assert cur.rows[1]["prev_hash"] is None


def test_verify_chain_passes_on_an_all_legacy_table():
    cur = FakeAuditTable()
    cur.insert_legacy_row()
    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is True
    assert broken_id is None


def test_verify_chain_passes_on_an_empty_table():
    cur = FakeAuditTable()
    is_valid, broken_id = audit.verify_chain(cur)
    assert is_valid is True
    assert broken_id is None
