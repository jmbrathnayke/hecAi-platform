-- Migration 021: add locale column to cases for localized notifications (Story 5.6, FR-6.3, OQ-B).
-- Default is 'si' (Sinhala), which aligns with the citizen portal's primary default.
-- Safe, idempotent column addition.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'si';
