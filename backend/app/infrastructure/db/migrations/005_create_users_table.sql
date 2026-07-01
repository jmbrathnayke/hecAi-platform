-- Migration 005: users table (Story 3.1).
-- Mirrors the role/scope claims Supabase issues in the JWT user_metadata (officer:
-- assigned_divisions[], admin: district_id) so the backend has a durable, queryable
-- record independent of the token itself.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  supabase_uid UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('officer', 'admin')),
  assigned_divisions TEXT[],  -- officer division scope
  district_id BIGINT,         -- admin district scope
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_role_scope_check CHECK (
    (role = 'officer' AND assigned_divisions IS NOT NULL AND district_id IS NULL)
    OR (role = 'admin' AND district_id IS NOT NULL AND assigned_divisions IS NULL)
  )
);

-- The backend accesses this table only via a direct psycopg2 connection (DATABASE_URL),
-- never through Supabase's auto-generated PostgREST API — but without RLS enabled, Postgres
-- tables are served by PostgREST to any anon-key holder (the anon key ships client-side).
-- Enabling RLS with no policies defaults to deny-all for PostgREST/API roles while leaving
-- the backend's direct connection unaffected.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
