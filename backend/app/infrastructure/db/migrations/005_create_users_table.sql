-- Migration 005: users table (Story 3.1).
-- Mirrors the role/scope claims Supabase issues in the JWT user_metadata (officer:
-- assigned_divisions[], admin: district_id) so the backend has a durable, queryable
-- record independent of the token itself.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  supabase_uid UUID UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('officer', 'admin')),
  assigned_divisions TEXT[],  -- officer division scope
  district_id BIGINT,         -- admin district scope
  created_at TIMESTAMPTZ DEFAULT NOW()
);
