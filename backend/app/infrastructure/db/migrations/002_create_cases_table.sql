-- Migration 002: cases table + canonical id sequence.
-- offline_id is the client-generated UUID-v4 (the only id that exists offline);
-- canonical_id (HEC-YYYY-NNNN) is assigned server-side on first submission.

CREATE TABLE IF NOT EXISTS cases (
  id BIGSERIAL PRIMARY KEY,
  offline_id UUID UNIQUE NOT NULL,
  canonical_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'Submitted',
  damage_category TEXT NOT NULL,
  gps_lat NUMERIC(10,7),
  gps_lng NUMERIC(10,7),
  submitter_identity_hash TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS hec_canonical_seq START 1;
