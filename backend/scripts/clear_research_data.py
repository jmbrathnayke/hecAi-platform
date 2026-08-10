"""Remove synthetic research cases and everything hanging off them (Story 7.4, AC5/AC6).

    python -m scripts.clear_research_data --dry-run                        # counts + verdict
    python -m scripts.clear_research_data --yes                            # strict delete
    python -m scripts.clear_research_data --yes --include-orphan-audit     # after any export

THE AUDIT HASH CHAIN IS THE WHOLE DIFFICULTY HERE.

`audit_log` is chained globally in id order (migration 012): each row's `hash` covers the
previous row's `hash`. `verify_chain()` walks the table and reports the first row whose
`prev_hash` doesn't match the previous hashed row's actual hash. Delete a row that has a
NON-seeded row after it and the chain is broken permanently — surfaced to admins through Story
5.4's "Verify chain integrity" button, with no repair path short of rehashing the table, which
is exactly the tampering the chain exists to detect.

So deletion of audit rows is allowed only when the seeded rows form a CONTIGUOUS TAIL of the
table. Otherwise this script refuses and deletes nothing.

WHY THERE IS NO --keep-audit FLAG (deviation from the story's Task 3, deliberate and recorded):
`audit_log.case_id` is a plain `REFERENCES cases(id)` with no ON DELETE action, so an audit row
pins its case in place. "Keep the audit rows but delete the cases" is not a state Postgres will
let us reach. Nulling `case_id` instead is worse — `case_id` is inside the hashed payload, so
rewriting it breaks the chain just as surely as deleting the row. The flag was specified before
that FK was checked; it cannot be built as described, so the guarded all-or-nothing clear is the
only honest behaviour.

CONSEQUENCE, and it is a real operational constraint: once a genuine case is submitted after a
seed run, its audit row sits after the seeded ones and the seeded corpus can no longer be
cleared. Clear before resuming real submissions, or accept that the corpus stays.
"""
import argparse
import os
import sys

import psycopg2
from dotenv import load_dotenv

from app.infrastructure.audit import _AUDIT_CHAIN_LOCK_KEY, verify_chain
from scripts._seed_common import SEED_ACTOR

# Deletion order matters: only compensation_estimates cascades (migration 013). inference_log,
# audit_log and payment_authorizations are plain REFERENCES, so a cases-first DELETE raises a
# foreign-key violation. compensation_estimates is deleted explicitly rather than relying on its
# cascade, so the order reads as the dependency graph it actually is.
_CHILD_DELETES = (
    ("payment_authorizations", "DELETE FROM payment_authorizations WHERE case_id = ANY(%s)"),
    ("inference_log", "DELETE FROM inference_log WHERE case_id = ANY(%s)"),
    ("compensation_estimates", "DELETE FROM compensation_estimates WHERE case_id = ANY(%s)"),
)


if hasattr(sys.stdout, "reconfigure"):  # pragma: no cover - environment-dependent
    sys.stdout.reconfigure(encoding="utf-8")


# Events written with case_id IS NULL that --include-orphan-audit may sweep. This is an
# ALLOWLIST, not "anything case-less", and the distinction matters: the first version matched on
# `case_id IS NULL` alone, which also swept `compensation_cap_updated` (a genuine system
# configuration change) and `admin_exported_cases` (an NFR-3.4 data-egress record). Both are real
# FR-5.5 retention records that happen to carry no case_id; deleting them alongside synthetic data
# would be destroying audit history, which is precisely what the chain exists to prevent.
#
# Everything here records LOOKING at data. `research_exported_data` is included because it is the
# row that verifying the seeded corpus creates — the whole reason this flag has to exist.
SWEEPABLE_ORPHAN_EVENTS = (
    "admin_viewed_cases",
    "admin_viewed_analytics",
    "admin_viewed_compensation_caps",
    "admin_verified_chain",
    "officer_viewed_cases",
    "research_exported_data",
)


class ChainGuardRefusal(RuntimeError):
    """Raised when deleting seeded audit rows would break the hash chain.

    Carries the partial `report` so the caller can print the chain verdict on a refusal too —
    AC6 asks for the before/after verification on EVERY path, and an earlier version emitted the
    report only on the success path.
    """

    def __init__(self, message, report=None):
        super().__init__(message)
        self.report = report or {}


def _seeded_case_ids(cur):
    cur.execute("SELECT id FROM cases WHERE seeded ORDER BY id")
    return [r[0] for r in cur.fetchall()]


def _seeded_audit_ids(cur, case_ids, include_orphans=False):
    """Audit rows this script may delete.

    Strict (default): written by the seeder AND attached to a seeded case. Both conditions,
    never either — `actor_id` alone would sweep up anything a future script happens to name
    'seed-script', and `case_id` alone would sweep up a real admin action taken on a seeded case
    while someone was demoing.

    With `include_orphans`, also case-less rows written after seeding began whose event is in
    SWEEPABLE_ORPHAN_EVENTS. Why this exists: calling `GET /api/v1/research/export` ONCE writes
    such a row, and it then sits after every seeded row and blocks the strict clear forever.
    Since exporting the corpus is the entire point of seeding it, strict mode alone is unusable
    in practice — verified the hard way on 2026-08-10. Kept opt-in, and kept to an allowlist,
    because a case-less audit row is not automatically disposable.
    """
    cur.execute(
        "SELECT id FROM audit_log WHERE actor_id = %s AND case_id = ANY(%s) ORDER BY id",
        (SEED_ACTOR, case_ids),
    )
    ids = [r[0] for r in cur.fetchall()]
    if include_orphans and ids:
        cur.execute(
            "SELECT id FROM audit_log WHERE case_id IS NULL AND id > %s AND event = ANY(%s) "
            "ORDER BY id",
            (min(ids), list(SWEEPABLE_ORPHAN_EVENTS)),
        )
        ids = sorted(ids + [r[0] for r in cur.fetchall()])
    return ids


def check_audit_tail(cur, audit_ids):
    """Return the ids of non-seeded audit rows sitting after the first seeded one.

    Empty list == the seeded rows are a contiguous tail == safe to delete.
    """
    if not audit_ids:
        return []
    cur.execute(
        "SELECT id FROM audit_log WHERE id > %s AND NOT (id = ANY(%s)) ORDER BY id",
        (min(audit_ids), audit_ids),
    )
    return [r[0] for r in cur.fetchall()]


def clear(cur, *, dry_run, include_orphans=False):
    """Delete the seeded corpus. Raises ChainGuardRefusal rather than risking the chain."""
    # Serialise against concurrent audit writers for the rest of this transaction. Without it
    # there is a TOCTOU window: a real submission committing between the post-delete
    # verify_chain() and our COMMIT chains its prev_hash onto a row we are deleting, so both
    # transactions succeed, verification reported clean, and the chain is broken anyway.
    # write_audit_log() takes the same key (infrastructure/audit.py), so acquiring it here makes
    # this script and every submission mutually exclusive.
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (_AUDIT_CHAIN_LOCK_KEY,))

    case_ids = _seeded_case_ids(cur)
    report = {"seeded_cases": len(case_ids), "deleted": {}, "dry_run": dry_run,
              "include_orphans": include_orphans}

    if not case_ids:
        report["chain_before"] = verify_chain(cur)
        report["chain_after"] = report["chain_before"]  # nothing changed
        report["note"] = "Nothing seeded; nothing to do."
        return report

    valid_before, broken_before = verify_chain(cur)
    report["chain_before"] = (valid_before, broken_before)
    if not valid_before:
        # Refuse on a pre-existing break too: deleting into an already-broken chain makes the
        # damage indistinguishable from ours.
        report["chain_after"] = report["chain_before"]  # nothing deleted
        raise ChainGuardRefusal(
            f"audit_log chain is ALREADY broken at row id={broken_before}, before this script "
            "touched anything. Investigate that first — deleting now would obscure the cause.",
            report,
        )

    audit_ids = _seeded_audit_ids(cur, case_ids, include_orphans=include_orphans)
    intruders = check_audit_tail(cur, audit_ids)
    report["seeded_audit_rows"] = len(audit_ids)
    report["interleaved_foreign_audit_rows"] = intruders

    if intruders:
        cur.execute(
            "SELECT event, actor_id, case_id FROM audit_log WHERE id = ANY(%s) ORDER BY id "
            "LIMIT 10",
            (intruders,),
        )
        blocking = [{"event": e, "actor_id": a, "case_id": c} for e, a, c in cur.fetchall()]
        report["blocking_rows"] = blocking

        hint = ""
        if not include_orphans:
            sweepable = {r["event"] for r in blocking} <= set(SWEEPABLE_ORPHAN_EVENTS)
            if sweepable and all(r["case_id"] is None for r in blocking):
                hint = (" Every blocking row is a case-less view/export record — "
                        "`--include-orphan-audit` would sweep them up with the corpus.")
        report["chain_after"] = report["chain_before"]  # nothing deleted
        raise ChainGuardRefusal(
            f"{len(intruders)} non-seeded audit_log row(s) were written after the first seeded "
            f"one (ids: {intruders[:10]}{'...' if len(intruders) > 10 else ''}; events: "
            f"{sorted({r['event'] for r in blocking})}). Deleting the seeded rows would break "
            "the hash chain from that point on, and the FK from audit_log.case_id means the "
            f"cases cannot be removed while their audit rows remain. Nothing was deleted.{hint}",
            report,
        )

    if dry_run:
        for table, _ in _CHILD_DELETES:
            column = "case_id"
            cur.execute(f"SELECT count(*) FROM {table} WHERE {column} = ANY(%s)", (case_ids,))
            report["deleted"][table] = cur.fetchone()[0]
        report["deleted"]["audit_log"] = len(audit_ids)
        report["deleted"]["cases"] = len(case_ids)
        report["note"] = "--dry-run: counts are what WOULD be deleted; no writes performed."
        return report

    for table, sql in _CHILD_DELETES:
        cur.execute(sql, (case_ids,))
        report["deleted"][table] = cur.rowcount

    cur.execute("DELETE FROM audit_log WHERE id = ANY(%s)", (audit_ids,))
    report["deleted"]["audit_log"] = cur.rowcount

    cur.execute("DELETE FROM cases WHERE id = ANY(%s)", (case_ids,))
    report["deleted"]["cases"] = cur.rowcount

    valid_after, broken_after = verify_chain(cur)
    report["chain_after"] = (valid_after, broken_after)
    if not valid_after:
        # The guard should make this unreachable. If it ever fires, the guard's reasoning is
        # wrong and the only safe move is to abandon the whole transaction.
        raise ChainGuardRefusal(
            f"Chain verification FAILED after deletion at row id={broken_after}. Rolling back — "
            "no rows were removed. The contiguous-tail guard did not hold; do not retry until "
            "that is understood."
        )

    cur.execute("SELECT count(*) FROM cases WHERE seeded")
    report["seeded_remaining"] = cur.fetchone()[0]
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Remove seeded research cases.")
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--yes", action="store_true", help="Required to actually delete.")
    parser.add_argument(
        "--include-orphan-audit", action="store_true",
        help="Also delete case-less audit rows (exports, chain verifications) written after "
             "seeding began. Needed whenever the corpus has been exported even once.",
    )
    args = parser.parse_args(argv)

    if not args.dry_run and not args.yes:
        print("Refusing to delete without --yes (or use --dry-run first).", file=sys.stderr)
        return 2

    load_dotenv()
    url = args.database_url or os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set (and --database-url not given).", file=sys.stderr)
        return 2

    conn = psycopg2.connect(url, connect_timeout=45)
    try:
        with conn:
            with conn.cursor() as cur:
                report = clear(cur, dry_run=args.dry_run,
                               include_orphans=args.include_orphan_audit)
                if args.dry_run:
                    conn.rollback()
    except ChainGuardRefusal as exc:
        import json as _json
        print(f"\nREFUSED — nothing deleted.\n{exc}", file=sys.stderr)
        # AC6 asks for the chain verdict on every path, refusal included.
        print(_json.dumps(exc.report, ensure_ascii=False, indent=2, default=str))
        return 1
    finally:
        conn.close()

    import json
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
