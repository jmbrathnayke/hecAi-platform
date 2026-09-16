-- Migration 026: the Divisional Secretariat officer (Story 8.5, PRD Section 3).
--
-- Adds a FOURTH role. Before Epic 8 the PRD collapsed "DWC Administrator / Divisional Secretary"
-- into one district-scoped role, which did not match the real process: compensation is disbursed
-- through the Divisional Secretariat at DS-DIVISION level, one level below the district a DWC
-- administrator oversees. The two are different jobs and are now modelled separately.
--
-- THE DISTRICT ADMIN ROLE IS UNTOUCHED. Epic 7's analytics and the admin case pipeline must keep
-- working exactly as before; this migration only widens what `role` may contain and adds a column
-- that is NULL for every existing row.
--
-- Scope width, for the record — three roles, three widths, all read from the verified JWT:
--   officer      officer_id = me OR ds_division_id = ANY(assigned_divisions)
--   ds_officer   ds_division = <my one division>            <- new
--   admin        district = <my district>
--
-- The CHECK constraint has to be dropped and recreated: Postgres has no ALTER CONSTRAINT for
-- CHECK expressions. Both statements are guarded so re-running this file is safe, which matters
-- in a project with no migration runner (see scripts/check_migration_parity.py).

ALTER TABLE users ADD COLUMN IF NOT EXISTS ds_division TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_scope_check;

-- Role vocabulary. 'system_admin' is deliberately ABSENT: it authorises the research export
-- (require_research, Story 7.3) purely from the JWT and has never had a users row — see that
-- guard's docstring. Adding it here would imply a durable record this platform does not keep.
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('officer', 'admin', 'ds_officer'));

-- Exactly one scope per role, and never another role's scope. A ds_officer carrying
-- assigned_divisions would be ambiguous about which query should scope them.
ALTER TABLE users ADD CONSTRAINT users_role_scope_check CHECK (
  (role = 'officer'
     AND assigned_divisions IS NOT NULL AND district_id IS NULL AND ds_division IS NULL)
  OR (role = 'admin'
     AND district_id IS NOT NULL AND assigned_divisions IS NULL AND ds_division IS NULL)
  OR (role = 'ds_officer'
     AND ds_division IS NOT NULL AND assigned_divisions IS NULL AND district_id IS NULL)
);

-- Backs the DS case list (GET /api/v1/ds/cases) joining a staff row to its division.
CREATE INDEX IF NOT EXISTS idx_users_ds_division
  ON users (ds_division) WHERE ds_division IS NOT NULL;
