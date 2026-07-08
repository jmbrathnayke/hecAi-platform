-- Migration 010: division hook for officer-scoped case reads (Story 3.7, NFR-3.2).
--
-- Story 3.1's AC5 assumed cases could be filtered by ds_division_id, but no such column existed.
-- This adds it, NULLABLE — no submit path populates it yet (GPS->DS-division mapping, or stamping
-- it on the officer-assisted/SMS submit paths, is a future story). The officer dashboard filters
--   officer_id = <me> OR (ds_division_id IS NOT NULL AND ds_division_id = ANY(<my divisions>))
-- so existing NULL rows simply match on the officer_id branch (an officer sees their own cases).
--
-- Numbered 010 to reserve 008/009 for Story 3.6 (SMS fallback, on its own branch). Idempotent.
-- Indexes back the scoped query.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS ds_division_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cases_officer_id ON cases (officer_id);
CREATE INDEX IF NOT EXISTS idx_cases_ds_division_id ON cases (ds_division_id);
