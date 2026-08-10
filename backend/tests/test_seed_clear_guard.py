"""Tests for the seed cleaner's audit hash-chain guard (Story 7.4, AC5/AC6).

DB faked (no Postgres), same spirit as tests/test_admin_export.py — but the fake here stores
REAL hash-chained rows built with `audit._compute_hash`, so `verify_chain()` runs for real
against them. That matters: the guard's entire justification is a claim about what deletion does
to the chain, and `test_deleting_interleaved_rows_really_does_break_the_chain` proves that claim
rather than assuming it. Without that test the guard is cargo-cult.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.infrastructure.audit import _compute_hash, verify_chain
from scripts._seed_common import SEED_ACTOR
from scripts.clear_research_data import ChainGuardRefusal, check_audit_tail, clear

T0 = datetime(2026, 8, 1, 9, 0, tzinfo=timezone.utc)


class FakeCursor:
    """Enough of psycopg2's cursor for clear() and verify_chain(). Dispatches on SQL text the
    way tests/test_admin_export.py's harness does."""

    def __init__(self, store):
        self.store = store
        self._rows = []

    # -- helpers -------------------------------------------------------------------------
    def _audit_sorted(self):
        return sorted(self.store["audit"], key=lambda r: r["id"])

    def execute(self, sql, params=None):
        s = " ".join(sql.split())
        p = params or ()

        if s.startswith("SELECT pg_advisory_xact_lock"):
            self._rows = [(True,)]
        elif s.startswith("SELECT event, actor_id, case_id FROM audit_log WHERE id = ANY"):
            ids = set(p[0])
            self._rows = [(r["event"], r["actor_id"], r["case_id"])
                          for r in self._audit_sorted() if r["id"] in ids][:10]
        elif s.startswith("SELECT id FROM cases WHERE seeded"):
            self._rows = [(c["id"],) for c in self.store["cases"] if c["seeded"]]
        elif s.startswith("SELECT count(*) FROM cases WHERE seeded"):
            self._rows = [(sum(1 for c in self.store["cases"] if c["seeded"]),)]
        elif s.startswith("SELECT id, case_id, event, actor_id, metadata, created_at, hash, prev_hash"):
            self._rows = [
                (r["id"], r["case_id"], r["event"], r["actor_id"], r["metadata"],
                 r["created_at"], r["hash"], r["prev_hash"])
                for r in self._audit_sorted()
            ]
        elif s.startswith("SELECT id FROM audit_log WHERE actor_id"):
            actor, case_ids = p
            self._rows = [(r["id"],) for r in self._audit_sorted()
                          if r["actor_id"] == actor and r["case_id"] in case_ids]
        elif s.startswith("SELECT id FROM audit_log WHERE case_id IS NULL AND id >"):
            min_id, allowed = p
            self._rows = [(r["id"],) for r in self._audit_sorted()
                          if r["case_id"] is None and r["id"] > min_id
                          and r["event"] in allowed]
        elif s.startswith("SELECT id FROM audit_log WHERE id >"):
            min_id, audit_ids = p
            self._rows = [(r["id"],) for r in self._audit_sorted()
                          if r["id"] > min_id and r["id"] not in audit_ids]
        elif s.startswith("SELECT count(*) FROM"):
            table = s.split("FROM ")[1].split(" ")[0]
            self._rows = [(sum(1 for cid in self.store["children"][table] if cid in p[0]),)]
        elif s.startswith("DELETE FROM audit_log"):
            ids = set(p[0])
            before = len(self.store["audit"])
            self.store["audit"] = [r for r in self.store["audit"] if r["id"] not in ids]
            self.rowcount = before - len(self.store["audit"])
        elif s.startswith("DELETE FROM cases"):
            ids = set(p[0])
            before = len(self.store["cases"])
            self.store["cases"] = [c for c in self.store["cases"] if c["id"] not in ids]
            self.rowcount = before - len(self.store["cases"])
        elif s.startswith("DELETE FROM"):
            table = s.split("DELETE FROM ")[1].split(" ")[0]
            ids = set(p[0])
            kept = [cid for cid in self.store["children"][table] if cid not in ids]
            self.rowcount = len(self.store["children"][table]) - len(kept)
            self.store["children"][table] = kept
        else:  # pragma: no cover - a new query would be a real change worth noticing
            raise AssertionError(f"FakeCursor got unexpected SQL: {s}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


def _chain(entries):
    """Build a genuinely hash-chained audit_log, exactly as write_audit_log would have."""
    rows, prev = [], None
    for i, (case_id, actor) in enumerate(entries, start=1):
        created = T0 + timedelta(minutes=i)
        meta = {"seeded": actor == SEED_ACTOR}
        h = _compute_hash(prev, case_id, "submitted", actor, meta, created.isoformat())
        rows.append({"id": i, "case_id": case_id, "event": "submitted", "actor_id": actor,
                     "metadata": meta, "created_at": created, "hash": h, "prev_hash": prev})
        prev = h
    return rows


def _store(entries, seeded_ids, real_ids=()):
    cases = [{"id": i, "seeded": True} for i in seeded_ids]
    cases += [{"id": i, "seeded": False} for i in real_ids]
    return {
        "cases": cases,
        "audit": _chain(entries),
        "children": {"payment_authorizations": list(seeded_ids),
                     "inference_log": list(seeded_ids),
                     "compensation_estimates": list(seeded_ids)},
    }


# --- the premise the whole guard rests on -------------------------------------------------

def test_deleting_interleaved_rows_really_does_break_the_chain():
    """Not a test of our code — a test of the claim our code is built on. A real audit row
    written after a seeded one, then the seeded rows removed, must leave verify_chain() broken.
    If this ever stops being true, the guard is unnecessary complexity and should go."""
    store = _store([(1, SEED_ACTOR), (2, SEED_ACTOR), (99, "real-admin")],
                   seeded_ids=[1, 2], real_ids=[99])
    cur = FakeCursor(store)
    assert verify_chain(cur) == (True, None)

    store["audit"] = [r for r in store["audit"] if r["actor_id"] != SEED_ACTOR]
    valid, broken = verify_chain(cur)
    assert valid is False
    assert broken == 3  # the surviving real row's prev_hash now points at a deleted row


def test_deleting_a_contiguous_tail_leaves_the_chain_intact():
    """The mirror image, and the reason the guard permits this case at all."""
    store = _store([(99, "real-admin"), (1, SEED_ACTOR), (2, SEED_ACTOR)],
                   seeded_ids=[1, 2], real_ids=[99])
    cur = FakeCursor(store)
    store["audit"] = [r for r in store["audit"] if r["actor_id"] != SEED_ACTOR]
    assert verify_chain(cur) == (True, None)


# --- check_audit_tail ---------------------------------------------------------------------

def test_check_audit_tail_accepts_a_contiguous_tail():
    cur = FakeCursor(_store([(99, "real-admin"), (1, SEED_ACTOR)], [1], [99]))
    assert check_audit_tail(cur, [2]) == []


def test_check_audit_tail_reports_interlopers():
    cur = FakeCursor(_store([(1, SEED_ACTOR), (99, "real-admin"), (2, SEED_ACTOR)], [1, 2], [99]))
    assert check_audit_tail(cur, [1, 3]) == [2]


def test_check_audit_tail_is_vacuously_safe_with_no_seeded_audit_rows():
    cur = FakeCursor(_store([(99, "real-admin")], [], [99]))
    assert check_audit_tail(cur, []) == []


# --- clear() ------------------------------------------------------------------------------

def test_clear_removes_everything_seeded_and_nothing_else():
    store = _store([(99, "real-admin"), (1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2], [99])
    cur = FakeCursor(store)
    report = clear(cur, dry_run=False)

    assert report["deleted"]["cases"] == 2
    assert report["deleted"]["audit_log"] == 2
    assert report["deleted"]["inference_log"] == 2
    assert report["seeded_remaining"] == 0
    assert report["chain_after"] == (True, None)
    # the real case and its audit row survive untouched
    assert [c["id"] for c in store["cases"]] == [99]
    assert [r["actor_id"] for r in store["audit"]] == ["real-admin"]


def test_clear_refuses_and_deletes_nothing_when_rows_are_interleaved():
    store = _store([(1, SEED_ACTOR), (99, "real-admin"), (2, SEED_ACTOR)], [1, 2], [99])
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal, match="non-seeded audit_log row"):
        clear(cur, dry_run=False)

    assert len(store["cases"]) == 3
    assert len(store["audit"]) == 3
    assert verify_chain(cur) == (True, None)


def test_clear_refuses_when_the_chain_was_already_broken():
    store = _store([(1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2])
    store["audit"][1]["event"] = "tampered"  # content no longer matches its stored hash
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal, match="ALREADY broken"):
        clear(cur, dry_run=False)
    assert len(store["cases"]) == 2


def test_dry_run_reports_counts_without_deleting():
    store = _store([(1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2])
    cur = FakeCursor(store)
    report = clear(cur, dry_run=True)

    assert report["dry_run"] is True
    assert report["deleted"] == {"payment_authorizations": 2, "inference_log": 2,
                                 "compensation_estimates": 2, "audit_log": 2, "cases": 2}
    assert len(store["cases"]) == 2
    assert len(store["audit"]) == 2


def test_clear_is_a_noop_when_nothing_is_seeded():
    cur = FakeCursor(_store([(99, "real-admin")], [], [99]))
    report = clear(cur, dry_run=False)
    assert report["seeded_cases"] == 0
    assert "Nothing seeded" in report["note"]


# --- orphan bookkeeping rows (the trap found during live verification) ---------------------

def _with_orphan(store, orphan_id, actor="verify-researcher",
                 event="research_exported_data"):
    """Append a case-less audit row, correctly chained onto the tail — what a single call to
    GET /api/v1/research/export (or an admin view, or a cap change) leaves behind."""
    tail = max(store["audit"], key=lambda r: r["id"])
    created = tail["created_at"] + timedelta(minutes=1)
    meta = {"row_count_at_audit": 50}
    h = _compute_hash(tail["hash"], None, event, actor, meta, created.isoformat())
    store["audit"].append({"id": orphan_id, "case_id": None, "event": event,
                           "actor_id": actor, "metadata": meta, "created_at": created,
                           "hash": h, "prev_hash": tail["hash"]})
    return store


def test_one_export_blocks_the_strict_clear_and_the_message_says_so():
    """Verified against the live database on 2026-08-10: exporting the corpus once — the entire
    reason the corpus exists — left a case-less audit row that made the strict clear refuse."""
    store = _with_orphan(_store([(1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2]), orphan_id=3)
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal, match="include-orphan-audit"):
        clear(cur, dry_run=False)
    assert len(store["cases"]) == 2  # nothing deleted


def test_include_orphans_clears_the_corpus_and_keeps_the_chain_valid():
    store = _with_orphan(_store([(1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2]), orphan_id=3)
    cur = FakeCursor(store)
    report = clear(cur, dry_run=False, include_orphans=True)

    assert report["deleted"]["cases"] == 2
    assert report["deleted"]["audit_log"] == 3  # 2 seeded + the export row
    assert report["chain_after"] == (True, None)
    assert store["audit"] == []


def test_orphan_rows_predating_the_seed_are_left_alone():
    """`id > min(seeded audit id)` matters: a bookkeeping row from before seeding is somebody
    else's record and must survive."""
    store = _store([(99, "real-admin"), (1, SEED_ACTOR)], [1], [99])
    early = {"id": 0, "case_id": None, "event": "research_exported_data",
             "actor_id": "someone-else", "metadata": None, "created_at": T0,
             "hash": None, "prev_hash": None}
    store["audit"].insert(0, early)
    cur = FakeCursor(store)

    clear(cur, dry_run=False, include_orphans=True)
    assert [r["id"] for r in store["audit"]] == [0, 1]


def test_a_config_change_is_never_swept_even_with_the_flag():
    """`compensation_cap_updated` carries case_id IS NULL but is a genuine system configuration
    change, not bookkeeping. The first version of the orphan sweep matched on `case_id IS NULL`
    alone and would have deleted it — along with `admin_exported_cases`, an NFR-3.4 data-egress
    record. Both are real FR-5.5 retention rows; the sweep is an allowlist for that reason."""
    store = _with_orphan(_store([(1, SEED_ACTOR), (2, SEED_ACTOR)], [1, 2]), orphan_id=3,
                         actor="real-admin", event="compensation_cap_updated")
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal) as exc:
        clear(cur, dry_run=False, include_orphans=True)

    assert "compensation_cap_updated" in str(exc.value)
    assert len(store["cases"]) == 2
    assert any(r["event"] == "compensation_cap_updated" for r in store["audit"])


def test_an_admin_data_export_is_never_swept_either():
    store = _with_orphan(_store([(1, SEED_ACTOR)], [1]), orphan_id=2,
                         actor="real-admin", event="admin_exported_cases")
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal):
        clear(cur, dry_run=False, include_orphans=True)
    assert any(r["event"] == "admin_exported_cases" for r in store["audit"])


def test_refusal_reports_the_chain_verdict_and_the_blocking_rows():
    """AC6 asks for verify_chain before AND after on every path, refusal included. The first
    version attached chain_after only to the success path and printed nothing on a refusal."""
    store = _with_orphan(_store([(1, SEED_ACTOR)], [1]), orphan_id=2,
                         actor="real-admin", event="compensation_cap_updated")
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal) as exc:
        clear(cur, dry_run=False, include_orphans=True)

    report = exc.value.report
    assert report["chain_before"] == (True, None)
    assert report["chain_after"] == (True, None)   # nothing deleted, so unchanged
    assert report["blocking_rows"][0]["event"] == "compensation_cap_updated"


def test_a_real_case_audit_row_still_blocks_even_with_the_flag():
    """The flag widens the sweep to case-less bookkeeping only. A genuine event on a real case
    must still refuse — that is the case the guard exists for."""
    store = _store([(1, SEED_ACTOR), (99, "real-admin"), (2, SEED_ACTOR)], [1, 2], [99])
    cur = FakeCursor(store)
    with pytest.raises(ChainGuardRefusal):
        clear(cur, dry_run=False, include_orphans=True)
    assert len(store["cases"]) == 3


def test_legacy_null_hash_row_does_not_count_as_a_break():
    """The live dev DB's only audit row (id=1, created 2026-07-07) predates migration 012 and has
    a NULL hash. verify_chain() skips it; the guard must not mistake it for tampering."""
    store = _store([(1, SEED_ACTOR)], [1])
    legacy = {"id": 0, "case_id": 3, "event": "submitted", "actor_id": "real",
              "metadata": None, "created_at": T0, "hash": None, "prev_hash": None}
    store["audit"].insert(0, legacy)
    cur = FakeCursor(store)
    assert verify_chain(cur) == (True, None)
    report = clear(cur, dry_run=False)
    assert report["chain_after"] == (True, None)
