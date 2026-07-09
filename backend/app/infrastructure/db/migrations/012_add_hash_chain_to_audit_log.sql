-- Migration 012: SHA-256 hash-chain for audit_log (FR-5.5, AD-4).
--
-- Closes a 2026-07-10 as-built audit finding: neither a cryptographic hash chain NOR the
-- documented Postgres-role tamper-evidence (migration 003's REVOKE step) was ever actually
-- in place. The app connects as the database OWNER role (`neondb_owner` on Neon), which
-- retains full UPDATE/DELETE/TRUNCATE regardless of any REVOKE — table ownership bypasses
-- grants in Postgres — so migration 003's manual REVOKE instruction was never operable as
-- written and was never run. This migration adds the real cryptographic chain instead
-- (computed/verified in app/infrastructure/audit.py). Role-separation (a dedicated,
-- non-owner app role with UPDATE/DELETE actually revoked) remains a documented follow-up —
-- it requires provisioning a new Neon role and rotating DATABASE_URL, out of scope here.
--
-- `hash`/`prev_hash` are nullable: the single pre-existing row (id=1, created 2026-07-07)
-- predates the chain. It is left NULL rather than fabricating a backfilled hash for an
-- entry that was never actually chained when written — verify_chain() treats a NULL-hash
-- row as a documented legacy entry and begins chain verification from the first hashed row.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;
