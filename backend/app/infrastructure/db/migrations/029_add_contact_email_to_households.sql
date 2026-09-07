-- Migration 029: households.contact_email (email status notifications).
--
-- WHY THE HOUSEHOLD AND NOT THE CASE. Migration 020 added cases.citizen_mobile_plain and its own
-- comment records the outcome: the column "stays NULL for every case from those channels", because
-- the app and officer-assisted paths AES-GCM encrypt the citizen's contact details client-side with
-- a non-extractable key the server can never decrypt (frontend/lib/crypto.ts, NFR-3.1). A plaintext
-- email column on `cases` would inherit exactly that fate and notify nobody.
--
-- Registration is different. It is the one path that already transmits server-readable citizen data
-- by design -- the deliberate, documented NFR-3.1 exception recorded in Addendum A8, which exists so
-- the server can derive nic_hmac and hold bank details the DS office must be able to read. An email
-- address belongs with that data, under the same exception, and needs no further amendment.
--
-- Since migration 025 every case carries household_id, and the FR-10.3 submit gate makes it
-- mandatory, so case -> household -> contact_email resolves for every new case.
--
-- OPTIONAL BY DESIGN. A citizen who gives no address is not blocked from registering or claiming;
-- the notification is skipped and audit-logged, exactly as notification_service.py does for a
-- missing mobile. The public status page (FR-6.1) remains the channel that needs nothing at all.
--
-- NOT PII-EXPORTABLE. Like nic_hmac and bank_details_ciphertext, this column must never appear in
-- research.py exports, admin case lists, officer views, or infrastructure/export/report.py.

ALTER TABLE households ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- Case-insensitive lookup support; addresses are stored as entered but compared folded.
CREATE INDEX IF NOT EXISTS idx_households_contact_email
  ON households (lower(contact_email))
  WHERE contact_email IS NOT NULL;
