-- Migration 005: users table (Story 3.1).
-- Mirrors the role/scope claims Supabase issues in the JWT user_metadata (officer:
-- assigned_divisions[], admin: district_id) so the backend has a durable, queryable
-- record independent of the token itself.
--
-- Deviation (documented, 2026-07-07): the app database was split from Supabase's own
-- Postgres onto standalone Neon — `auth.users` (Supabase Auth's table) does not exist here,
-- so `supabase_uid` can no longer carry a same-database FOREIGN KEY REFERENCES auth.users(id).
-- It stays a UNIQUE NOT NULL UUID holding the Supabase JWT `sub`; referential integrity
-- against Supabase Auth is enforced at the application layer (JWT signature verification),
-- not by Postgres. The original `ON DELETE CASCADE` behavior (removing the row when the
-- Supabase Auth user is deleted) is no longer automatic and would need an application-level
-- or webhook-driven cleanup if that guarantee is required later.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  supabase_uid UUID UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('officer', 'admin')),
  assigned_divisions TEXT[],  -- officer division scope
  district_id BIGINT,         -- admin district scope
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_role_scope_check CHECK (
    (role = 'officer' AND assigned_divisions IS NOT NULL AND district_id IS NULL)
    OR (role = 'admin' AND district_id IS NOT NULL AND assigned_divisions IS NULL)
  )
);

-- RLS note (Supabase-era rationale, kept for defense-in-depth): the backend accesses this
-- table only via a direct psycopg2 connection (DATABASE_URL). The original concern —
-- Supabase's auto-generated PostgREST API serving this table to any anon-key holder — does
-- not apply on standalone Neon (no PostgREST layer here). RLS is left enabled anyway as
-- cheap defense-in-depth; it does not restrict the table-owning role's direct connection
-- (the backend's role) since FORCE ROW LEVEL SECURITY is not set.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
