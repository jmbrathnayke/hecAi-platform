-- Migration 004: approved compensation amount (Story 2.5).
-- Populated when a case reaches status 'Approved'; surfaced read-only on the public
-- claim-status lookup. NULL until an officer approves a payout.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS approved_amount NUMERIC(12,2);
