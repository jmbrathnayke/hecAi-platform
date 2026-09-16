-- Migration 025: link a case to the household that claimed it (Story 8.4, FR-10.3 / FR-10.6).
--
-- NULLABLE, deliberately, for three populations that must stay valid:
--   * every case submitted before Epic 8 existed;
--   * seeded research rows (migration 022) -- seed_research_data.py writes SQL directly and
--     never passes through the submit gate, by design;
--   * the SMS path's historical rows.
-- The gate applies to NEW submissions. Backfilling old cases is not possible: their
-- submitter_identity_hash is per-submission salted and cannot be matched to a registrant.
--
-- FR-10.6 CONSEQUENCE. From this story, cases.district and cases.ds_division_id are copied FROM
-- the household rather than accepted from the client. They stay nullable columns because the rows
-- above still carry NULLs, but no new case can be written with them empty. That closes the live
-- hole documented in migration 010: a case with ds_division_id IS NULL never matches the
-- division-scoped officer query (officer.py:61) and is effectively invisible to the officers whose
-- area it is in.
--
-- ON DELETE is deliberately absent (defaults to NO ACTION): a household with cases attached must
-- not be deletable, and FR-10.5's registrant transfer changes households.status rather than
-- removing the row. Compare compensation_estimates (013), which DOES cascade -- an estimate is
-- meaningless without its case, whereas a case is a legal record that outlives the registry entry.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES households(id);

-- Backs "every case for this family", which the DS case detail (Story 8.5) and the FR-10.5
-- transfer both read. Partial: NULL for every pre-Epic-8 and seeded row, and none of those are
-- ever looked up this way.
CREATE INDEX IF NOT EXISTS idx_cases_household_id
  ON cases (household_id) WHERE household_id IS NOT NULL;
