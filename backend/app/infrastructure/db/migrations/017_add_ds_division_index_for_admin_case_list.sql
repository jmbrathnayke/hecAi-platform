-- Migration 017: composite index for the admin case-list's DS Division filter (Story 5.3
-- code review fix). Migration 016 covered submitted_at/status/damage_category under the
-- district predicate but missed ds_division_id, which the FilterBar's "DS Division" filter
-- (c.ds_division_id = %s) also runs under WHERE district = %s.

CREATE INDEX IF NOT EXISTS idx_cases_district_ds_division ON cases (district, ds_division_id);
