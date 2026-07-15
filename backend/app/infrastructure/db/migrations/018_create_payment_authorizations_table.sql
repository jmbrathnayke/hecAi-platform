-- Migration 018: payment_authorizations table (Story 5.5, FR-5.6). Created on case approval
-- only; no fund transfer happens in this system -- this is a downstream trigger record for
-- DWC's existing external financial disbursement process.
--
-- No citizen-identity column: no readable citizen name/contact field exists anywhere in this
-- schema for any submission channel (confirmed against all 17 prior migrations) -- case_id,
-- joined to cases.canonical_id, is the practical case/citizen reference this system can
-- actually produce. Same resolution class as Stories 5.3/5.4's NIC-field decisions.
--
-- Append-only by convention (like audit_log/inference_log) -- not DB-role-enforced, matching
-- this codebase's existing, documented limitation (the app connects as the Neon owner role,
-- which bypasses grants/revokes; see deferred-work.md's 2026-07-10 audit entry).

CREATE TABLE IF NOT EXISTS payment_authorizations (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES cases(id),
  amount_lkr NUMERIC(12,2) NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
