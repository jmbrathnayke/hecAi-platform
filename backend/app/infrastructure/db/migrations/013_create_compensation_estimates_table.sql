-- Migration 013: compensation_estimates table (Story 5.2, FR-4.1/FR-4.5).
-- One estimate per case (UNIQUE case_id) -- a case is estimated once, on first
-- receipt (submit, sync, or SMS); re-estimation is out of scope for this story.

CREATE TABLE IF NOT EXISTS compensation_estimates (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  amount_lkr NUMERIC(12,2) NOT NULL,
  raw_estimate_lkr NUMERIC(12,2) NOT NULL,
  capped BOOLEAN NOT NULL DEFAULT FALSE,
  feature_values_json JSONB NOT NULL,
  model_version TEXT NOT NULL,
  dataset_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compensation_estimates_case_id ON compensation_estimates (case_id);
