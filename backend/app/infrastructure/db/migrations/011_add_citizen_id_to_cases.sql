-- Migration 011: citizen case-ownership hook (Story 4.0, NFR-3.2 citizen leg).
--
-- Set ONLY when an AUTHENTICATED citizen submits online (POST /cases/submit with a citizen JWT);
-- the anonymous path leaves it NULL and the officer-assisted path (submitted_by_officer=true) also
-- leaves it NULL. Mirrors officer_id (migration 007). The "My Cases" list filters on it.
--
-- Citizens are NOT rows in the users table (that table's CHECK is officer/admin-only and requires a
-- division/district scope citizens don't have) — ownership lives here as the Supabase UID string.
--
-- Numbered 011 (010 = ds_division_id, Story 3.7). Idempotent (IF NOT EXISTS). Indexed for the query.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS citizen_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cases_citizen_id ON cases (citizen_id);
