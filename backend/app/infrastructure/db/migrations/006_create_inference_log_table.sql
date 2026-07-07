-- Migration 006: append-only inference_log (Story 3.4).
-- Research / accountability record of every AI inference and any officer override (FR-2.4,
-- NFR-6.3 override-rate metric, NFR-3.4 append-only 5-year retention). Like audit_log (003),
-- the application DB role is granted INSERT + SELECT only (no UPDATE/DELETE) so the record is
-- tamper-evident at the Postgres role level, not in app code.
--
-- Deviation from architecture schema (documented, PO-approved 2026-07-06): adds
-- `override_category` so the log records what the officer corrected the class TO, not just
-- that an override happened. `case_id` is BIGINT to match cases.id (BIGSERIAL), like audit_log.

CREATE TABLE IF NOT EXISTS inference_log (
  id              BIGSERIAL PRIMARY KEY,
  case_id         BIGINT REFERENCES cases(id),
  model_type      VARCHAR(20) NOT NULL,          -- mobilenetv2 | random_forest
  model_version   VARCHAR(20) NOT NULL,
  input_features  JSONB NOT NULL,                -- {offline_id, officer_id, ai_severity, ai_processing_time_ms}
  prediction      VARCHAR(50) NOT NULL,          -- the AI's original prediction (never mutated)
  confidence      DECIMAL(5,4),
  ground_truth    VARCHAR(50),                   -- set later by admin review (Story 5.x)
  was_overridden  BOOLEAN DEFAULT FALSE,
  override_reason TEXT,
  override_category VARCHAR(30),                 -- corrected class the officer selected (added column)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Run once per environment with a superuser, after the app role exists:
--   REVOKE UPDATE, DELETE ON inference_log FROM <app_role>;
--   GRANT  INSERT, SELECT ON inference_log TO   <app_role>;

-- AC5 override-rate query (NFR-6.3), computable from inference_log alone:
--   SELECT count(*) FILTER (WHERE was_overridden)::decimal / count(*)
--   FROM inference_log WHERE model_type = 'mobilenetv2';
