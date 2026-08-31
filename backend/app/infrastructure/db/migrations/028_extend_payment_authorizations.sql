-- Migration 028: household + disbursement columns on payment_authorizations (Story 8.6, FR-5.6).
--
-- Migration 018 created this table with case_id, amount_lkr, authorized_by, authorized_at and an
-- explicit note that no citizen-identity column existed anywhere in the schema to reference. The
-- household registry (023) changed that: household_ref is now the identifier a Divisional
-- Secretariat officer actually quotes, and FR-5.6 was amended to require it here.
--
-- TWO DISTINCT ACTORS write to one row, and the columns keep them apart:
--   authorized_by / authorized_at     the DWC administrator APPROVING the claim (Story 5.5)
--   ds_authorized_by / ds_authorized_at   the Divisional Secretariat RELEASING the money (8.6)
-- Conflating them would make the audit trail unable to answer who did which, which is exactly the
-- accountability the hash-chained log exists to provide.
--
-- bank_account_last4 is copied here at approval time so the payment record is self-contained: a
-- household that later changes its account must not retroactively rewrite what an existing
-- authorisation says was paid. NEVER the full number -- that lives encrypted on households and is
-- decrypted at exactly one call site.
--
-- All columns NULLABLE: rows written before this migration have none, and ds_authorized_* stay
-- NULL until the DS office actually releases the payment.

ALTER TABLE payment_authorizations ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES households(id);
ALTER TABLE payment_authorizations ADD COLUMN IF NOT EXISTS bank_account_last4 TEXT;
ALTER TABLE payment_authorizations ADD COLUMN IF NOT EXISTS ds_authorized_by TEXT;
ALTER TABLE payment_authorizations ADD COLUMN IF NOT EXISTS ds_authorized_at TIMESTAMPTZ;

-- "Which payments has this family received?" — the DS verification panel and FR-10.5 transfer.
CREATE INDEX IF NOT EXISTS idx_payment_auth_household_id
  ON payment_authorizations (household_id) WHERE household_id IS NOT NULL;
