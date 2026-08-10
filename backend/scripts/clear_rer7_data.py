"""Remove everything the RER-7 harness (frontend/e2e/rer7-offline.mjs) wrote.

WHY A DEDICATED SCRIPT. clear_research_data.py only removes rows flagged `seeded`, and the
harness deliberately does not set that flag -- its cases must look like ordinary submissions to
the code under test, or the measurement would be measuring a special case. Harness rows are
instead identifiable by audit actor: sync.py stamps every audit row with the verified JWT
`sub`, which the harness mints as 'rer7-officer-*' / 'rer7-admin-*'. The cases themselves carry
officer_id = NULL (the payload never sets submitted_by_officer) and so cannot be identified
from the cases table at all.

THE HASH CHAIN IS THE CONSTRAINT. audit_log is a SHA-256 chain: each row hashes the previous
one. Deleting a row from the middle invalidates every row after it, and the admin UI reports
that as tampering. Deleting a contiguous TAIL is safe -- nothing points forward. This script
therefore refuses unless every audit row at or after the first harness row is itself a harness
row, re-checked inside the transaction while holding the same advisory lock write_audit_log()
takes, so a submission landing mid-run cannot be chained onto a row being removed.

  python scripts/clear_rer7_data.py            # dry run: report only
  python scripts/clear_rer7_data.py --apply    # delete, verifying the chain before commit
"""
import argparse
import os
import sys

import psycopg2
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from app.infrastructure.audit import _AUDIT_CHAIN_LOCK_KEY, verify_chain  # noqa: E402

ACTOR_PREFIX = "rer7-"

# FK-safe order. Only compensation_estimates cascades from cases; the rest must go first.
CHILD_TABLES = ("payment_authorizations", "inference_log", "compensation_estimates")


class Refusal(Exception):
    pass


def collect(cur):
    cur.execute(
        "SELECT id FROM audit_log WHERE actor_id LIKE %s ORDER BY id", (ACTOR_PREFIX + "%",)
    )
    audit_ids = [r[0] for r in cur.fetchall()]
    cur.execute(
        "SELECT DISTINCT case_id FROM audit_log WHERE actor_id LIKE %s AND case_id IS NOT NULL",
        (ACTOR_PREFIX + "%",),
    )
    case_ids = [r[0] for r in cur.fetchall()]
    return audit_ids, case_ids


def check_contiguous_tail(cur, audit_ids):
    """Refuse unless the harness rows are an unbroken tail of the chain."""
    if not audit_ids:
        return
    cur.execute(
        "SELECT id, actor_id, event FROM audit_log "
        "WHERE id >= %s AND (actor_id IS NULL OR actor_id NOT LIKE %s) ORDER BY id",
        (min(audit_ids), ACTOR_PREFIX + "%"),
    )
    intruders = cur.fetchall()
    if intruders:
        raise Refusal(
            f"{len(intruders)} non-harness audit row(s) were written after the harness's first "
            f"one, e.g. {[(r[0], r[1], r[2]) for r in intruders[:5]]}. Deleting the harness rows "
            "would break the hash chain from that point on. Nothing was deleted."
        )


def check_no_foreign_references(cur, case_ids):
    """Refuse if a non-harness audit row points at a case we are about to delete -- removing the
    case would either violate the FK or force us to delete an audit row we have no claim to."""
    if not case_ids:
        return
    cur.execute(
        "SELECT id, actor_id, event, case_id FROM audit_log "
        "WHERE case_id = ANY(%s) AND (actor_id IS NULL OR actor_id NOT LIKE %s) ORDER BY id",
        (case_ids, ACTOR_PREFIX + "%"),
    )
    foreign = cur.fetchall()
    if foreign:
        raise Refusal(
            f"{len(foreign)} audit row(s) written by someone else reference harness cases, e.g. "
            f"{foreign[:5]}. Nothing was deleted."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    args = parser.parse_args()

    load_dotenv(".env")
    url = os.getenv("DATABASE_URL")
    if not url:
        sys.exit("ERROR: DATABASE_URL is not set.")

    conn = psycopg2.connect(url, connect_timeout=45)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            # Lock FIRST. Everything below is checked under it, so a concurrent submission cannot
            # chain onto a row this transaction is about to remove (the TOCTOU that a
            # survey-then-delete script would have).
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_AUDIT_CHAIN_LOCK_KEY,))

            audit_ids, case_ids = collect(cur)
            if not audit_ids and not case_ids:
                print("Nothing to clean: no rer7-* audit rows found.")
                conn.rollback()
                return 0

            print(f"harness audit rows : {len(audit_ids)} (ids {min(audit_ids)}..{max(audit_ids)})")
            print(f"harness cases      : {len(case_ids)}")
            for table in CHILD_TABLES:
                cur.execute(f"SELECT count(*) FROM {table} WHERE case_id = ANY(%s)", (case_ids,))
                print(f"  {table:<24} {cur.fetchone()[0]}")

            # Guard against ever touching the research corpus, whatever the actor says.
            cur.execute("SELECT count(*) FROM cases WHERE seeded AND id = ANY(%s)", (case_ids,))
            seeded_hits = cur.fetchone()[0]
            if seeded_hits:
                raise Refusal(f"{seeded_hits} of these cases are flagged seeded. Nothing deleted.")

            check_contiguous_tail(cur, audit_ids)
            check_no_foreign_references(cur, case_ids)
            print("\nchecks passed: harness rows are a contiguous tail, nothing else references them")

            if not args.apply:
                print("\nDry run. Re-run with --apply to delete.")
                conn.rollback()
                return 0

            for table in CHILD_TABLES:
                cur.execute(f"DELETE FROM {table} WHERE case_id = ANY(%s)", (case_ids,))
            cur.execute("DELETE FROM audit_log WHERE id = ANY(%s)", (audit_ids,))
            cur.execute("DELETE FROM cases WHERE id = ANY(%s)", (case_ids,))

            valid, broken = verify_chain(cur)
            if not valid:
                raise Refusal(
                    f"chain invalid at row id={broken} after the deletes -- rolling back. The "
                    "contiguity check passed but the chain did not, which needs investigating."
                )

            conn.commit()
            print(f"\nDeleted {len(case_ids)} case(s) and {len(audit_ids)} audit row(s). "
                  f"Chain verified valid before commit.")
            return 0
    except Refusal as exc:
        conn.rollback()
        print(f"\nREFUSED: {exc}")
        return 1
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
