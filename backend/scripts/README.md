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

Deterministic **given a fixed clock**: `random.Random(20260810)` plus `uuid5`-derived
`offline_id`s. Every attribute except the timestamps is identical across runs; `submitted_at`,
`updated_at` and therefore the year inside `canonical_id` are relative to when you run it, since
`build_plan()` defaults `now` to the wall clock. The tests pin `now` explicitly, so only they see
full determinism.

Re-running against a seeded database reports `created=0, skipped=50` and does not advance
`hec_canonical_seq`.

**`--count` cannot be changed on an existing corpus.** Every attribute except `offline_id`
depends on the count — the shuffles are over `range(count)`, `submitted_at` divides by
`count - 1`, and the quotas are `round(count * rate)`. Re-seeding at a different count would skip
the existing rows by `offline_id` and append rows planned under different assumptions, silently
breaking the status quotas and the exact 0.30 override rate while still reporting success. The
seeder refuses; clear first. The minimum is 12 (below that the corpus cannot cover four statuses
and four districts, and the scenario assertions fail rather than skip).

## Two things that will bite you

**1. Clearing can be refused, and one export is enough to trigger it.**

`audit_log` is a global SHA-256 hash chain (migration 012). Deleting a row that has a *later*
row after it breaks every hash from that point on — permanently, and visibly, through Story 5.4's
"Verify chain integrity" button. So the cleaner deletes audit rows only when the ones it owns
form a contiguous tail, and it verifies the chain before *and* after, rolling back on any break.

Calling `GET /api/v1/research/export` writes a case-less `research_exported_data` audit row.
After that, the strict clear refuses — which is absurd, since exporting the corpus is the whole
point of seeding it. `--include-orphan-audit` widens the sweep to case-less rows written after seeding began whose
event is on an explicit allowlist — `admin_viewed_cases`, `admin_viewed_analytics`,
`admin_viewed_compensation_caps`, `admin_verified_chain`, `officer_viewed_cases`,
`research_exported_data`. All of those record *looking at* data.

It deliberately does **not** sweep `compensation_cap_updated` (a genuine system configuration
change) or `admin_exported_cases` (an NFR-3.4 data-egress record), even though both also carry
`case_id IS NULL`, nor any audit row attached to a real case. Those still refuse — which is the
case the guard exists for. The refusal message names the blocking events so you can see what is
in the way.

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

On a machine that *does* have a database, `pytest -m "not scenario"` excludes the suite.

The suite creates real cases and cleans up after itself under the same contiguous-tail rule. If
teardown cannot delete safely it fails loudly and leaves the rows in place rather than corrupting
the chain.

**Scope honesty:** these scenarios evidence the *server* half of RER-7 — idempotency, no
duplicates, stable `canonical_id` across retries. RER-7's ≥95% offline *submission completion
rate* is a PWA property (service worker + IndexedDB `sync_queue`, Stories 4.1/4.4) that a backend
test client cannot measure. Do not quote these results as the whole of RER-7.

## End-to-end smoke test

`scripts/e2e_smoke.ps1` boots both tiers against the dev database and probes every
research-relevant surface — auth gates, the PII-stripped export, admin analytics and KPIs, the
audit-chain verification, and the citizen/officer/admin page shells.

```powershell
./scripts/e2e_smoke.ps1                 # backend + frontend
./scripts/e2e_smoke.ps1 -SkipFrontend   # API only, ~20s
./scripts/e2e_smoke.ps1 -AllowWrites    # also exercises a real submission (writes to the chain)
```

**It is not read-only, and cannot be**: every admin/officer/research read endpoint writes an
access-audit row. What the default run avoids is rows the cleaner *cannot* sweep — the CSV-export
probe is gated behind `-AllowWrites` for exactly that reason, since `admin_exported_cases` is an
NFR-3.4 record the cleaner refuses to delete and it will then block clearing the seeded corpus.

Writes a JSON report to `e2e-report.json` and exits non-zero on any failure.

---

# Staff authorization claims (auth hardening, 2026-08-13)

The API guards trust `app_metadata` only — it is writable exclusively with the service-role key,
which is precisely why the Supabase dashboard renders it read-only. Granting staff their claims
therefore has to go through the Auth Admin API. Two scripts do related but **different** jobs, and
running only one of them is the most common way to lock everyone out:

| Script | What it does | When you need it |
|---|---|---|
| `migrate_auth_metadata.py` | **Copies** `role` / `district_id` / `assigned_divisions` that a user *already has* in `user_metadata` across to `app_metadata` | Accounts that predate the 2026-08-11 claim move |
| `set_staff_claims.py` | **Originates** claims from the command line; never reads `user_metadata` | Anyone who never had claims in `user_metadata` — which is every Google-OAuth signup |

A staff member who signed up through Google OAuth has nothing in `user_metadata`, so
`migrate_auth_metadata.py` reports `0 users would be updated` and skips them. That message reads
like "nothing to do" and is the trap: it usually means every account still needs
`set_staff_claims.py`. **Verify per user, not per script** — after either one, confirm
`app_metadata.role` is non-empty for every officer and admin.

## Granting an officer their divisions

```powershell
$env:SUPABASE_URL = "https://<project>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"   # NOT the anon key

# Dry run first — prints before/after and writes nothing
.\venv\Scripts\python.exe scripts\set_staff_claims.py --user <uuid> --role officer `
    --divisions-from scripts\data\officer-app-metadata.json

# Then apply
.\venv\Scripts\python.exe scripts\set_staff_claims.py --user <uuid> --role officer `
    --divisions-from scripts\data\officer-app-metadata.json --apply
```

`data/officer-app-metadata.json` holds the 32 Sinhala DS-division names for the Hambantota-area
officer account. **These strings are load-bearing**: they must match `cases.ds_division_id`
byte-for-byte or the officer's dashboard silently returns an empty list, and one of them
(`ශ්‍රාවස්තිපුර`, index 27) contains a zero-width joiner `U+200D` that will not survive being
retyped by hand. That is why the file is version-controlled rather than regenerated per-operator.
To rebuild it for a different area:

```sql
SELECT DISTINCT ds_division_id FROM cases WHERE district = '<district>' ORDER BY 1;
```

## After running either script

Claims are baked into a JWT when it is issued, so **the user must sign out and back in.** An
already-issued token keeps its old (roleless) claims until it expires — up to an hour — and until
then the change looks like it did nothing.
