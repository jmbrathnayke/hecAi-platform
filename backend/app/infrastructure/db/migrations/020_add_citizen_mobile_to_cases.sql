-- Migration 020: citizen_mobile_plain (Story 5.6, FR-6.3).
--
-- Same precedent/reasoning as citizen_nic_plain (migration 009): the only channel that can ever
-- produce a PLAINTEXT, server-readable citizen contact number is the one channel with no client
-- to encrypt with (SMS-fallback, Story 3.6). The app/officer-assisted channels DO capture a
-- mobile number, but AES-GCM encrypt it client-side with a non-extractable key the server can
-- never decrypt (frontend/lib/crypto.ts) -- so this column stays NULL for every case from those
-- channels. Write-only-by-convention like its NIC sibling -- never returned by any read endpoint.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS citizen_mobile_plain TEXT;
