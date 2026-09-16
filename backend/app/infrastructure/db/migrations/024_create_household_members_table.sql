-- Migration 024: household_members (Story 8.1, FR-10.1 / FR-10.2).
--
-- THIS TABLE'S UNIQUE INDEX IS THE DUPLICATE-COMPENSATION CONTROL. Everything else in Epic 8 --
-- the registration form, the submit gate, the DS surface -- exists to put rows in here and read
-- them back. If ux_household_members_nic is dropped, the whole control is gone and the system
-- silently returns to paying one family twice for one loss. Story 8.3 mutation-verifies exactly
-- that: dropping this index must make a test fail.
--
-- nic_hmac = HMAC-SHA256(NIC_PEPPER, canonical_nic) -- see app/infrastructure/security/
-- nic_identity.py for the derivation and for why the plaintext NIC is never stored. In one line:
-- the client cannot compute this (the pepper would have to ship to every browser, and anyone
-- holding it could enumerate the registry offline by hashing candidate NICs), and the existing
-- client-side AES-GCM key is non-extractable and per-device so the server can never decrypt an
-- existing NIC ciphertext either. The plaintext NIC exists only in request memory. This is a
-- documented amendment to NFR-3.1 -- PRD Addendum A8.2 records the three rejected alternatives.
--
-- No plaintext name/NIC column pair beyond full_name, which is what a DS officer needs to read
-- aloud when verifying a claimant standing in front of them. full_name is NOT an identifier and
-- nothing matches on it.
--
-- Members are rows here whether or not they ever use the system. A declared brother who never
-- opens the app still occupies his NIC, which is the whole mechanism: he cannot later register
-- a second household for the same family.
--
-- STATED LIMITATION (PRD Addendum A8.4, architecture R-15). This blocks only DECLARED members.
-- An undeclared relative can still register separately -- the system has no independent source
-- of household composition and knows only what the registrant typed. In the real process that
-- gap is closed by the Grama Niladhari's household register, not by software. Recorded here so
-- nobody reading this schema concludes the control is stronger than it is.

CREATE TABLE IF NOT EXISTS household_members (
  id            BIGSERIAL PRIMARY KEY,
  household_id  BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  nic_hmac      TEXT NOT NULL,
  is_registrant BOOLEAN NOT NULL DEFAULT FALSE,
  full_name     TEXT,
  relationship  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FR-10.2. One government ID exists ONCE across the whole platform, registrant or declared
-- member. Not scoped to a household -- a NIC in household A must block registration of
-- household B, which is the entire point.
CREATE UNIQUE INDEX IF NOT EXISTS ux_household_members_nic
  ON household_members (nic_hmac);

-- FR-10.1. Exactly one registrant per household. PARTIAL, so the non-registrant members (the
-- majority of rows) are not forced unique on household_id -- only the single is_registrant row is.
CREATE UNIQUE INDEX IF NOT EXISTS ux_household_one_registrant
  ON household_members (household_id) WHERE is_registrant;

-- "Who is in this household?" -- the DS verification panel (Story 8.5) reads the member list.
CREATE INDEX IF NOT EXISTS idx_household_members_household_id
  ON household_members (household_id);
