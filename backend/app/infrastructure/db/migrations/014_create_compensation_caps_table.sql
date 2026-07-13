-- Migration 014: compensation_caps table (Story 5.2 builds it, Story 5.6 owns the
-- admin config UI that writes to it). Keyed on the RF model's OWN district vocabulary
-- (Sinhala TEXT, matching compensation_long.csv / the training data) -- NOT the admin
-- RBAC users.district_id (BIGINT, an unrelated numbering scheme; see story Open
-- Question 2). No rows are seeded -- DWC has not supplied real policy cap values yet;
-- an absent row means "no cap enforced" (see AC4).

CREATE TABLE IF NOT EXISTS compensation_caps (
  id BIGSERIAL PRIMARY KEY,
  district TEXT NOT NULL,
  damage_type TEXT NOT NULL,
  cap_amount_lkr NUMERIC(12,2) NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (district, damage_type)
);
