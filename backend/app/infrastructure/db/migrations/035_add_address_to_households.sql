-- Migration 035: households.address (the family's postal / home address).
--
-- Same footing as contact_email (029): registration is the one path that transmits server-readable
-- citizen data under the documented NFR-3.1 exception (Addendum A8), so the address travels with it
-- and needs no further amendment. Stored in the clear for the same reason: the DS office and the
-- citizen must be able to read it.
--
-- REQUIRED FOR NEW REGISTRATIONS, NULLABLE IN THE SCHEMA. POST /api/v1/households refuses a
-- registration without an address; households registered before this migration keep NULL rather
-- than being given an invented value, and the citizen profile shows it as not recorded.
--
-- NOT PII-EXPORTABLE. Like contact_email and bank_details_ciphertext, this column must never appear
-- in research.py exports, admin case lists, officer views, or infrastructure/export/report.py.

ALTER TABLE households ADD COLUMN IF NOT EXISTS address TEXT;
