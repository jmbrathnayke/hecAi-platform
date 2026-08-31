-- Migration 027: encrypted bank details on the household (Story 8.6, FR-10.4).
--
-- NUMBERING NOTE. architecture.md numbered these columns 025 when Epic 8 was planned; Story 8.4
-- took 025 for cases.household_id, so the bank columns land here at 027. The architecture doc is
-- corrected to match rather than the other way round -- migrations are the source of truth and
-- renumbering an applied migration is worse than a stale plan.
--
-- WHY THIS COLUMN EXISTS AT ALL. It reverses a declared PRD non-goal. The original Section 4b
-- excluded "in-system payment processing", which was read as excluding payment DATA too -- which
-- is why payment_authorizations (migration 018) was deliberately created with no citizen identity.
-- FR-10.4 reverses the data half only: the Divisional Secretariat is the body that actually
-- disburses compensation, so a system that models its workflow but cannot record where the money
-- goes models only part of it. The boundary is now "no fund transfer", not "no payment data".
-- Full reasoning in PRD Addendum A8.3.
--
-- ENCRYPTED, NOT PLAINTEXT, AND NOT HASHED. See app/infrastructure/security/bank_crypto.py:
-- the DS officer must READ the account number to pay it, so a digest is useless and the
-- client-side AES-GCM key is unusable (non-extractable, per-device -- a desk in Thalawa cannot
-- decrypt what a phone in a village encrypted). Fernet with a server-held BANK_DETAILS_KEY.
--
-- bank_account_last4 is the display-safe tail and the ONLY part any list, export, officer or
-- admin surface may show. It is stored separately rather than derived at read time precisely so
-- that showing it never requires decrypting anything.
--
-- ETHICS DEPENDENCY (architecture R-14). The NSBM ethics submission predates this reversal and
-- does not yet cover bank data. Until it does, ONLY synthetic or test data may be entered here.
--
-- Both columns are NULLABLE: bank details are optional at registration (a citizen may skip the
-- step and the DS office can add them later), and every household registered before this
-- migration has none.

ALTER TABLE households ADD COLUMN IF NOT EXISTS bank_details_ciphertext TEXT;
ALTER TABLE households ADD COLUMN IF NOT EXISTS bank_account_last4 TEXT;

-- Deliberately NO index on either column. Nothing looks a household up BY its bank details, and
-- an index on bank_account_last4 would create a queryable grouping of citizens by account tail.
