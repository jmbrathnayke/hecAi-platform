-- Migration 039: households.contact_mobile (optional mobile number, for the office to call).
--
-- Same footing as contact_email (029) and address (035): registration is the one path that
-- transmits server-readable citizen data under the documented NFR-3.1 exception (Addendum A8), so
-- the number travels with it and needs no further amendment. Stored in the clear because the
-- family and its Divisional Secretariat office must be able to read it.
--
-- NOT A NOTIFICATION CHANNEL. SMS was retired in migration 034 and stays retired: nothing sends a
-- message to this number. It is a contact detail a person may phone, and nothing else.
-- test_notification_channels.py still asserts that no phone number is part of the notification
-- contract.
--
-- OPTIONAL AND NORMALISED. NULL when the family gave none. Otherwise one canonical form, +947
-- followed by eight digits, whatever the citizen typed (07X XXX XXXX, 7XXXXXXXX, +94 7X...), so one
-- number has one spelling. The CHECK holds that even against a client that skips the API.
--
-- NOT PII-EXPORTABLE. Like contact_email, address and bank_details_ciphertext, this column must
-- never appear in research.py exports, admin case lists, officer views, or
-- infrastructure/export/report.py.

ALTER TABLE households ADD COLUMN IF NOT EXISTS contact_mobile TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'households_contact_mobile_format') THEN
    ALTER TABLE households
      ADD CONSTRAINT households_contact_mobile_format
      CHECK (contact_mobile IS NULL OR contact_mobile ~ '^\+947[0-9]{8}$');
  END IF;
END $$;
