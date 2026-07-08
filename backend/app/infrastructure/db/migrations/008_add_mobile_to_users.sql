-- Migration 008: officer mobile number for SMS-fallback sender resolution (Story 3.6, FR-1.4).
-- The inbound-SMS webhook resolves the reporting officer by matching the sender's phone number
-- against this column, so it must be stored in the same canonical form Twilio delivers in the
-- `From` field (E.164, e.g. +9477XXXXXXX). UNIQUE guarantees one officer per number.
-- Idempotent (IF NOT EXISTS) so re-running the migration set is safe.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT UNIQUE;
