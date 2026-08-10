-- Migration 022: mark synthetic research cases (Story 7.4, RER-4).
--
-- Why a test-data flag lives on a production table: it is the only marker that survives a
-- hand-edited canonical_id, and it is what clear_research_data.py deletes on. The alternatives
-- considered and rejected (Story 7.4 OQ-A): a "HEC-SEED-..." canonical-id namespace (diverges
-- from the id format every admin surface parses) and matching on the seeder's deterministic
-- offline_id set (correct, but invisible to a human running an ad-hoc SELECT).
--
-- FALSE for all real traffic — no application code path ever sets this column. It is written
-- only by backend/scripts/seed_research_data.py.
--
-- The index is PARTIAL: the flag is false for every genuine case, so indexing the false side
-- would be dead weight. `WHERE seeded` keeps the index to exactly the seeded rows, which is the
-- only set anything ever queries by this column.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS seeded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cases_seeded ON cases (seeded) WHERE seeded;
