-- Migration 041: a field officer may register a family in the field, provisionally.
--
-- WHY. Until now a household could only be registered by the family itself, on its own phone
-- (POST /households, citizen JWT). The field officer exists for the families who cannot do that --
-- no smartphone, no signal, no confidence with the app -- and those were exactly the families the
-- officer then had to turn away at step 1 of an officer-assisted report ("not registered").
--
-- WHY PROVISIONAL. Registering a family and filing its claim are two different people's acts on
-- the citizen path. If the same field officer can do both in one sitting, one person could invent a
-- household and claim for it. The NIC digest's UNIQUE index (migration 024) still stops a NIC being
-- registered twice, but it cannot tell whether a household is real. So an officer-registered
-- household is marked here, its claim proceeds as normal, and the Divisional Secretariat must verify
-- the household against the NIC card / Grama Niladhari register before it can authorise payment
-- (ds.py authorize_payment refuses with household_unverified until then).
--
--   registered_by_officer  the officer's user id (JWT sub); NULL when the family registered itself
--   verified_at/_by        set once by the DS officer; NULL until then
--
-- A citizen-registered household needs no verification and is unaffected: its three columns are NULL.

ALTER TABLE households ADD COLUMN IF NOT EXISTS registered_by_officer TEXT;
ALTER TABLE households ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE households ADD COLUMN IF NOT EXISTS verified_by TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'households_verified_pair') THEN
    ALTER TABLE households
      ADD CONSTRAINT households_verified_pair
      CHECK ((verified_at IS NULL) = (verified_by IS NULL));
  END IF;
END $$;
