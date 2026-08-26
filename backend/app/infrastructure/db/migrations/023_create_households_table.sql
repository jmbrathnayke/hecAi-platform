-- Migration 023: households table (Story 8.1, FR-10.1).
--
-- The household -- not the individual -- is the unit of claim. One person per family registers;
-- every incident that family reports is linked to this row. See PRD FR-10 and Addendum A8.
--
-- WHY THIS EXISTS AT ALL. Before Epic 8 the platform had no registration and no way to detect
-- that two claims came from one family. `cases.submitter_identity_hash` is deliberately
-- UNLINKABLE -- it is salted per submission by offline_id and re-randomised by the AES-GCM IV,
-- so one NIC produces a different value every time (correct for per-incident privacy, useless
-- for deduplication). The registry adds a second, deliberately LINKABLE identifier, confined to
-- household_members (migration 024). Both coexist on purpose; neither replaces the other.
--
-- household_ref is HH-YYYY-NNNN, assigned server-side from its own sequence -- the same shape and
-- mechanism as cases.canonical_id / hec_canonical_seq (migration 002), so the two id families
-- read alike to an officer holding a paper form.
--
-- district / ds_division are NOT NULL here, unlike cases.district and cases.ds_division_id which
-- are nullable hooks nothing reliably populates (migrations 010/015). That is the point: FR-10.6
-- has the case inherit its division FROM the household, which closes the hole where a case with
-- ds_division IS NULL is invisible to the division-scoped officer query (officer.py:61).
-- Values come from the district_reference.json vocabulary (canonical Sinhala names).
--
-- gn_division is free text and nullable. There is no Grama Niladhari ROLE in this release
-- (documented as future work, PRD Addendum A8 / architecture R-15); this column only records
-- what the registrant told us, so a DS officer has it to hand when verifying against the GN's
-- household register.
--
-- status: 'active' is the only state that satisfies the FR-10.3 submit gate. 'transferred' marks
-- a household whose registrant changed (FR-10.5, death/incapacity); 'revoked' is an administrative
-- close. Bank columns arrive in migration 025 (Story 8.6), NOT here -- 8.1 is schema + identity
-- only, and bank data carries an ethics dependency (architecture R-14) that must not be
-- entangled with the migration that creates the registry.

CREATE TABLE IF NOT EXISTS households (
  id             BIGSERIAL PRIMARY KEY,
  household_ref  TEXT UNIQUE NOT NULL,
  district       TEXT NOT NULL,
  ds_division    TEXT NOT NULL,
  gn_division    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'transferred', 'revoked')),
  registrant_uid TEXT,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS hec_household_seq START 1;

-- The DS case list (Story 8.5) and the FR-10.6 routing lookup both filter on division.
CREATE INDEX IF NOT EXISTS idx_households_ds_division ON households (ds_division);

-- "Which household does this signed-in citizen represent?" -- the FR-10.3 submit gate runs this
-- on every submission. PARTIAL because registrant_uid is NULL for a household registered by an
-- officer on a citizen's behalf, and those rows are never the target of this lookup.
CREATE INDEX IF NOT EXISTS idx_households_registrant_uid
  ON households (registrant_uid) WHERE registrant_uid IS NOT NULL;
