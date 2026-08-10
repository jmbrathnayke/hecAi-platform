# Research data seeding (Story 7.4, RER-4)

> **The rows these scripts write are SYNTHETIC.** Any metric computed from them — confusion
> matrix, MAE, override rate — measures nothing about model quality. RER-4 asks for *scenario
> testing*, not model evaluation. The dissertation's real model numbers live in
> `backend/ml/results/` (Story 7.3), reproduced from the held-out image split and the time-based
> compensation holdout. Seeded `inference_log` rows carry `model_version = 'seed-1.0'` so the two
> can never be conflated in an export.

## Why it exists

Before seeding, the dev database held **one** case, **zero** inference rows and **zero**
compensation estimates. Story 7.3's `GET /api/v1/research/export` returned `[]` and Story 7.1's
four analytics charts rendered empty. This is the only data source either of them has.

## Commands

Run as modules from `backend/` — `python scripts/seed_research_data.py` will `ImportError` on
`from app.infrastructure...`.

```bash
python -m scripts.seed_research_data --dry-run          # plan summary, no DB contact
python -m scripts.seed_research_data                    # 50 cases (the default RER-4 quotes)
python -m scripts.seed_research_data --count 150        # denser 12-month trend for Story 7.1

python -m scripts.clear_research_data --dry-run                     # counts + chain verdict
python -m scripts.clear_research_data --yes                         # strict delete
python -m scripts.clear_research_data --yes --include-orphan-audit  # after any export (see below)
```

Both accept `--database-url` to override `DATABASE_URL` from `.env`.

## What a seed run produces (count = 50)

| Property | Value |
|---|---|
| Districts | All 4 pilot districts, Sinhala names (13/13/12/12) |
| Statuses | 20 Submitted, 10 Under Review, 13 Approved, 7 Rejected |
| `damage_category` | 17 crop, 17 property, 16 combined — **never `none`** |
| `submitted_at` | Spread across the trailing 12 months (13 distinct months) |
| Compensation | One estimate per case, from the **real** `estimate_and_store()` |
| Inference | Exactly one row per case, `confidence` 0.3000–0.9500 |
| Override rate | Exactly 0.30, as migration 006's documented query computes it |
| `ground_truth` | Populated on every row; disagrees with `prediction` on 8 (16%) |
| Approved cases | Carry `approved_amount` ≠ the estimate, so MAE is non-zero |

Deterministic: `random.Random(20260810)` plus `uuid5`-derived `offline_id`s, so two runs against
two empty databases produce identical rows. Re-running against a seeded database reports
`created=0, skipped=50` and does not advance `hec_canonical_seq`.

## Two things that will bite you

**1. Clearing can be refused, and one export is enough to trigger it.**

`audit_log` is a global SHA-256 hash chain (migration 012). Deleting a row that has a *later*
row after it breaks every hash from that point on — permanently, and visibly, through Story 5.4's
"Verify chain integrity" button. So the cleaner deletes audit rows only when the ones it owns
form a contiguous tail, and it verifies the chain before *and* after, rolling back on any break.

Calling `GET /api/v1/research/export` writes a case-less `research_exported_data` audit row.
After that, the strict clear refuses — which is absurd, since exporting the corpus is the whole
point of seeding it. `--include-orphan-audit` widens the sweep to case-less bookkeeping rows
(exports, chain verifications) written after seeding began. It does **not** widen it to audit
rows attached to real cases; those still refuse, which is the case the guard exists for.

**If a real case is submitted and audited after a seed run, the corpus becomes unclearable.**
Clear before resuming real submissions, or accept that it stays.

There is deliberately **no `--keep-audit` flag**: `audit_log.case_id` is a plain
`REFERENCES cases(id)` with no `ON DELETE`, so an audit row pins its case in place. "Keep the
audit rows, delete the cases" is not a state Postgres will let us reach, and nulling `case_id`
instead would rewrite hashed content and break the chain just as surely.

**2. Clearing leaves a permanent gap in `hec_canonical_seq`.**

Seeded cases mint real canonical ids from the production sequence, because the admin list,
analytics, and export all parse that format. The sequence cannot be safely rewound while real
cases exist, so a clear-and-reseed cycle burns 50 values. Cosmetic, and expected.

## Scenario suite

`backend/tests/scenarios/` drives the real Flask routes against a real Postgres. It **skips**
unless `HEC_SCENARIO_DB_URL` is set:

```bash
HEC_SCENARIO_DB_URL="$DATABASE_URL" pytest tests/scenarios -v
```

A separate variable, deliberately: CI runs a bare `pytest -v` with no database, and gating on
`DATABASE_URL` would silently point the suite at whatever a developer's `.env` happens to hold.

The suite creates real cases and cleans up after itself under the same contiguous-tail rule. If
teardown cannot delete safely it fails loudly and leaves the rows in place rather than corrupting
the chain.

**Scope honesty:** these scenarios evidence the *server* half of RER-7 — idempotency, no
duplicates, stable `canonical_id` across retries. RER-7's ≥95% offline *submission completion
rate* is a PWA property (service worker + IndexedDB `sync_queue`, Stories 4.1/4.4) that a backend
test client cannot measure. Do not quote these results as the whole of RER-7.
