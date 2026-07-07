-- Migration 007: officer accountability fields on cases (Story 3.5, FR-1.2).
-- The officer-assisted submission mode records WHO assisted a citizen who could not
-- operate the app themselves. These columns are set ONLY on the officer-assisted path
-- (POST /cases/submit with submitted_by_officer=true, where officer_id is re-derived
-- from the verified JWT `sub`); the anonymous citizen path leaves officer_id NULL and
-- submitted_by_officer FALSE, so the existing behaviour is unchanged.
--
-- Numbered 007 to avoid colliding with 006 (inference_log, Story 3.4). Idempotent
-- (IF NOT EXISTS) so re-running the migration set is safe.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS officer_id TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS submitted_by_officer BOOLEAN NOT NULL DEFAULT FALSE;
