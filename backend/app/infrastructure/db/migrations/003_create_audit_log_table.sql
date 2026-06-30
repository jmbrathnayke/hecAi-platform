-- Migration 003: append-only audit_log.
-- The application DB role is granted INSERT + SELECT only (no UPDATE/DELETE) on this
-- table — tamper-evidence is enforced at the Postgres role level, not in app code.

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT REFERENCES cases(id),
  event TEXT NOT NULL,
  actor_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Run once per environment with a superuser, after the app role exists:
--   REVOKE UPDATE, DELETE ON audit_log FROM <app_role>;
--   GRANT  INSERT, SELECT ON audit_log TO   <app_role>;
