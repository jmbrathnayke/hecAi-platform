-- Migration 016: composite indexes for the admin case-list query (Story 5.3, NFR-1.3).
-- Every admin query is scoped by district first (WHERE district = %s, from the verified
-- JWT g.district_id claim), so district leads every composite index here.

CREATE INDEX IF NOT EXISTS idx_cases_district_submitted_at ON cases (district, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_district_status ON cases (district, status);
CREATE INDEX IF NOT EXISTS idx_cases_district_damage_category ON cases (district, damage_category);
