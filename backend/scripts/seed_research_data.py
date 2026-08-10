"""Seed synthetic HEC cases for dissertation scenario evaluation (Story 7.4, RER-4).

    python -m scripts.seed_research_data              # 50 cases, dev DATABASE_URL
    python -m scripts.seed_research_data --count 150  # denser 12-month trend for Story 7.1
    python -m scripts.seed_research_data --dry-run    # plan summary only, no writes

⚠️ The rows this writes are SYNTHETIC. Metrics computed from them — confusion matrix, MAE,
override rate — measure nothing about model quality. RER-4 asks for scenario testing, not model
evaluation. The dissertation's real numbers live in backend/ml/results/ (Story 7.3). Seeded
inference rows carry model_version='seed-1.0' so the two can never be conflated downstream.

WHY THIS WRITES SQL DIRECTLY INSTEAD OF CALLING THE API: `POST /api/v1/cases/submit` accepts no
`submitted_at`, so every case would be stamped NOW() and Story 7.1's 12-month trend chart would
collapse to a single spike. Backdating requires direct INSERTs. Everything downstream of the
INSERT — the compensation estimate and the audit row — still goes through the real production
code paths (`estimate_and_store`, `write_audit_log`) so the seeded corpus is shaped exactly like
real traffic.
"""
import argparse
import json
import os
import random
import sys

import psycopg2
from dotenv import load_dotenv

from app.infrastructure.audit import write_audit_log
from app.infrastructure.ml import compensation
from scripts._seed_common import (
    MIN_USEFUL_COUNT,
    DEFAULT_COUNT,
    RNG_SEED,
    SEED_ACTOR,
    SEED_MODEL_TYPE,
    SEED_MODEL_VERSION,
    build_plan,
)

# District names are Sinhala, and this is developed on Windows where stdout defaults to cp1252 —
# printing the plan summary would die with UnicodeEncodeError before doing anything useful.
if hasattr(sys.stdout, "reconfigure"):  # pragma: no cover - environment-dependent
    sys.stdout.reconfigure(encoding="utf-8")

_CASE_INSERT = """INSERT INTO cases
    (offline_id, canonical_id, status, damage_category, district, ds_division_id,
     submitted_at, updated_at, locale, submitted_by_officer, officer_id,
     submitted_via, seeded)
  VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'app', TRUE)
  RETURNING id"""

_INFERENCE_INSERT = """INSERT INTO inference_log
    (case_id, model_type, model_version, input_features, prediction, confidence,
     ground_truth, was_overridden, override_reason, override_category, created_at)
  VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, NULL, %s, %s)"""

_DECISION_EVENT = {"Approved": "case_approved", "Rejected": "case_rejected"}


def _seed_one(cur, case):
    """Create one seeded case and its dependents. Returns 'created' or 'skipped'."""
    cur.execute("SELECT id FROM cases WHERE offline_id = %s", (case["offline_id"],))
    if cur.fetchone() is not None:
        # Idempotency (AC4). Checked BEFORE nextval so a re-run cannot burn sequence values —
        # an INSERT ... ON CONFLICT DO NOTHING would have consumed one per skipped case.
        return "skipped"

    submitted_at = case["submitted_at"]
    cur.execute("SELECT nextval('hec_canonical_seq')")
    canonical_id = f"HEC-{submitted_at.year}-{cur.fetchone()[0]:04d}"

    cur.execute(_CASE_INSERT, (
        case["offline_id"], canonical_id, case["status"], case["damage_category"],
        case["district"], case["ds_division_id"], submitted_at, case["updated_at"],
        case["locale"], case["submitted_by_officer"], case["officer_id"],
    ))
    case_id = cur.fetchone()[0]

    write_audit_log(cur, case_id, "submitted", SEED_ACTOR, {"seeded": True})

    estimate = compensation.estimate_and_store(
        cur, case_id, case["damage_category"], case["ds_division_id"], submitted_at,
        district=case["district"], ai_severity=case["ai_severity"],
    )
    if estimate is None:
        # estimate_and_store is best-effort by design so a model failure can never fail a real
        # submission. Here that silence is the enemy: None means AC2 is already broken (almost
        # certainly a damage_category outside _DAMAGE_TYPE_MAP). Fail loudly, roll the lot back.
        raise RuntimeError(
            f"No compensation estimate for seed case {case['index']} "
            f"(damage_category={case['damage_category']!r}, district={case['district']!r}). "
            "Check the damage-category vocabulary and that the RF model is loadable."
        )

    cur.execute(_INFERENCE_INSERT, (
        case_id, SEED_MODEL_TYPE, SEED_MODEL_VERSION,
        # No officer_id in here. In production this JSONB carries one, which is why Story 7.3
        # excludes the whole column from the research export; seeded rows must not reintroduce
        # identity data into a column a future export change might un-exclude.
        json.dumps({"seeded": True, "ai_severity": case["ai_severity"]}),
        case["prediction"], case["confidence"], case["ground_truth"],
        case["was_overridden"], case["override_category"], submitted_at,
    ))

    if case["status"] == "Approved":
        approved = round(estimate["amount_lkr"] * case["approval_factor"], 2)
        cur.execute(
            "UPDATE cases SET approved_amount = %s WHERE id = %s", (approved, case_id)
        )

    event = _DECISION_EVENT.get(case["status"])
    if event:
        write_audit_log(cur, case_id, event, SEED_ACTOR, {"seeded": True})

    return "created"


def require_seeded_column(cur):
    """Fail with an actionable message, not a raw UndefinedColumn traceback, when migration 022
    has not been applied. There is no migration runner in this repo — .sql files are applied by
    hand — so a missing migration is a realistic first-run experience."""
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'cases' AND column_name = 'seeded'"
    )
    if cur.fetchone() is None:
        raise SystemExit(
            "cases.seeded does not exist — migration 022 has not been applied to this database.\n"
            "Apply backend/app/infrastructure/db/migrations/022_add_seeded_flag_to_cases.sql "
            "and re-run."
        )


def _summarise(plan):
    from collections import Counter
    disagree = sum(1 for c in plan if c["ground_truth"] != c["prediction"])
    overridden = sum(1 for c in plan if c["was_overridden"])
    return {
        "total": len(plan),
        "districts": dict(Counter(c["district"] for c in plan)),
        "statuses": dict(Counter(c["status"] for c in plan)),
        "damage_categories": dict(Counter(c["damage_category"] for c in plan)),
        "overridden": overridden,
        "override_rate": round(overridden / len(plan), 4),
        "ground_truth_disagreements": disagree,
        "disagreement_rate": round(disagree / len(plan), 4),
        "confidence_min": min(c["confidence"] for c in plan),
        "confidence_max": max(c["confidence"] for c in plan),
        "submitted_at_earliest": min(c["submitted_at"] for c in plan).date().isoformat(),
        "submitted_at_latest": max(c["submitted_at"] for c in plan).date().isoformat(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Seed synthetic HEC research cases.")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--dry-run", action="store_true", help="Plan only; touch no database.")
    args = parser.parse_args(argv)

    # `--count 0` used to reach _summarise() and die on ZeroDivisionError before the DB was even
    # contacted. Below MIN_USEFUL_COUNT the corpus cannot satisfy its own quotas (no Rejected
    # bucket, single district, single damage category), which makes the scenario suite fail
    # rather than skip.
    if args.count < MIN_USEFUL_COUNT:
        parser.error(
            f"--count must be at least {MIN_USEFUL_COUNT}; below that the corpus cannot cover "
            "all four statuses and all four districts, and the scenario assertions fail."
        )

    plan = build_plan(args.count, rng=random.Random(RNG_SEED))
    summary = _summarise(plan)
    print("Plan:", json.dumps(summary, ensure_ascii=False, indent=2))

    if args.dry_run:
        print("\n--dry-run: no database was contacted.")
        return 0

    load_dotenv()
    url = args.database_url or os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set (and --database-url not given).", file=sys.stderr)
        return 2

    if not compensation.is_model_available():
        print(f"RF model not loadable from {compensation.MODEL_PATH}", file=sys.stderr)
        return 2

    conn = psycopg2.connect(url, connect_timeout=45)
    try:
        created = skipped = 0
        # One transaction for the whole run: a partially-seeded corpus is worse than none, and
        # AC1's distribution guarantees only hold for a complete set.
        with conn:
            with conn.cursor() as cur:
                require_seeded_column(cur)

                # Every attribute except offline_id depends on --count (the shuffles are over
                # range(count), submitted_at divides by count-1, quotas are round(count*rate)).
                # Re-seeding at a different count therefore skips the existing rows by
                # offline_id and appends rows planned under different assumptions: the status
                # quotas, the exact 0.30 override rate and the 12-month spread all silently
                # break, while the run still reports success. Refuse instead.
                cur.execute("SELECT count(*) FROM cases WHERE seeded")
                existing = cur.fetchone()[0]
                if existing and existing != args.count:
                    raise SystemExit(
                        f"This database already holds {existing} seeded cases but --count is "
                        f"{args.count}. Mixing two counts produces a corpus whose distributions "
                        "match neither (AC1/AC3 would silently fail). Clear first:\n"
                        "  python -m scripts.clear_research_data --yes --include-orphan-audit"
                    )

                for case in plan:
                    if _seed_one(cur, case) == "created":
                        created += 1
                    else:
                        skipped += 1

                # Report what is actually IN the database, not what was planned — on a
                # partially-skipped run those differ, and the plan summary above is the
                # intention, not the outcome.
                cur.execute("SELECT count(*) FROM cases WHERE seeded")
                total_seeded = cur.fetchone()[0]
                cur.execute(
                    "SELECT coalesce(sum(ce.amount_lkr), 0), count(*) "
                    "FROM compensation_estimates ce JOIN cases c ON c.id = ce.case_id "
                    "WHERE c.seeded"
                )
                total_lkr, n_estimates = cur.fetchone()
                cur.execute(
                    "SELECT c.status, count(*) FROM cases c WHERE c.seeded GROUP BY 1 ORDER BY 1"
                )
                actual_statuses = dict(cur.fetchall())
    finally:
        conn.close()

    print(f"\ncreated={created}, skipped={skipped}, seeded rows now in DB={total_seeded}")
    print(f"actual statuses in DB: {actual_statuses}")
    print(f"compensation estimates: {n_estimates}, total estimated LKR: {float(total_lkr):,.2f}")
    if created == 0:
        print("Nothing new — the corpus was already seeded (idempotent re-run).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
