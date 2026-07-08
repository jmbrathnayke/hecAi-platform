-- Migration 009: SMS-fallback case fields (Story 3.6, FR-1.4).
--
-- submitted_via marks the intake channel ('app' for every PWA/officer-assisted path, 'sms' for
-- the fallback channel). DEFAULT 'app' keeps all existing rows correct with no backfill.
--
-- citizen_nic_plain is the ONLY server-side plaintext NIC on the platform. Every other path
-- AES-GCM encrypts the NIC client-side and the server only ever sees an offline_id-scoped SHA-256
-- (submitter_identity_hash). SMS has no client to encrypt with, so the plaintext NIC is stored
-- here for officer-accountable identification (PO-ratified 2026-07-08). submitter_identity_hash is
-- still populated (offline_id:nic) to keep that column uniformly shaped, but note it is a
-- per-submission opaque tag, NOT a value that cross-matches the PWA channel. This column is
-- write-only for accountability — it must never be returned by any read/status endpoint.
--
-- twilio_message_sid is the idempotency key. Twilio retries inbound webhooks on timeout/non-2xx,
-- and the SMS path mints a fresh server-side offline_id per call, so it cannot dedupe on offline_id
-- the way the citizen path does. MessageSid is stable across Twilio retries; UNIQUE + an
-- ON CONFLICT insert make redelivery idempotent (one case per real message).
--
-- Idempotent (IF NOT EXISTS) so re-running the migration set is safe.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS submitted_via TEXT NOT NULL DEFAULT 'app';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS citizen_nic_plain TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS twilio_message_sid TEXT UNIQUE;
