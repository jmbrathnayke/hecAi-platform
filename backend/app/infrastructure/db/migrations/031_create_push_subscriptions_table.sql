-- Migration 031: push_subscriptions (Web Push status notifications).
--
-- WHY THIS TABLE HOLDS NO PERSONAL DATA, which is the reason the channel exists at all.
-- A Web Push subscription is not a contact detail. `endpoint` is an opaque URL minted by the
-- browser's own push service, and p256dh/auth are the public half of a keypair used to encrypt
-- payloads to that one browser install. None of it identifies a person, reaches them through any
-- other route, or survives the user clearing site data. So unlike SMS (which needs a plaintext
-- mobile the server can read) and email (which needs a plaintext address), push requires NO
-- amendment to NFR-3.1 and adds nothing that has to be protected as citizen PII.
--
-- That inverts the constraint the privacy architecture created. Migration 020's comment records
-- that cases.citizen_mobile_plain "stays NULL for every case from those channels", because the
-- app encrypts contact details client-side with a non-extractable key. Push sidesteps the problem
-- rather than carving another exception out of it.
--
-- household_id is the routing key, matching households.contact_email (migration 029): a case
-- resolves to a household (migration 025, enforced by the FR-10.3 gate), and a household resolves
-- to every device its members have subscribed on. citizen_uid is kept for revocation -- when an
-- account is transferred (FR-10.5) its subscriptions must be removable without touching others.
--
-- ON DELETION. Push services return 404 or 410 Gone for a subscription that no longer exists;
-- push_service.py deletes the row on those, so the table self-prunes rather than accumulating
-- dead endpoints that slow every send.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  household_id BIGINT REFERENCES households(id),
  citizen_uid  TEXT,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT 'si',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- The send path is "given a case, find every device to notify", which is a household_id lookup.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_household
  ON push_subscriptions (household_id)
  WHERE household_id IS NOT NULL;

-- Revocation path: remove one account's devices without disturbing the rest of the family.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_citizen
  ON push_subscriptions (citizen_uid)
  WHERE citizen_uid IS NOT NULL;
