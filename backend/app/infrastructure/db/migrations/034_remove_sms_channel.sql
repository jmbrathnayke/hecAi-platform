-- Migration 034: retire SMS entirely. Notifications are Web Push and email only.
--
-- WHAT IS REMOVED, and why each object is safe to drop.
--
--   sms_templates              (019, extended by 033) Status-message wording for the SMS channel.
--                              Web Push also read its notification BODY from here, so the wording
--                              is first copied verbatim into push_templates below. Push output is
--                              byte-for-byte unchanged.
--   cases.citizen_mobile_plain (020) The only destination SMS notifications ever had. Populated
--                              only by the SMS intake grammar; the app channels always left it NULL.
--   cases.twilio_message_sid   (009) Idempotency key of the SMS intake webhook, which is removed.
--   cases.citizen_nic_plain    (009) Plaintext NIC written only by the SMS intake webhook. Dropping
--                              it removes the last plaintext-NIC column from the schema.
--   users.mobile_number        (008) Caller-ID lookup for the SMS intake webhook, nothing else.
--
-- NOT removed: cases.submitted_via. It describes every channel ('app', ...) and may hold the
-- historical value 'sms' on older deployments; reading it needs no SMS capability.
--
-- AUDIT HISTORY IS KEPT. Rows such as sms_skipped_no_mobile already in audit_log stay: the log is
-- append-only and hash-chained, so deleting or rewriting them would break verify_chain(). No code
-- writes an sms_* event after this migration.
--
-- DATA SAFETY. Each dropped column is checked first. If any row holds a value, the migration
-- raises and the transaction rolls back rather than silently destroying data. That guards another
-- deployment that did use SMS intake; the reference deployment held no values when this was
-- written (verified 2026-09-17).
--
-- Idempotent: every statement is IF [NOT] EXISTS, and the copy runs only while sms_templates exists.

-- ------------------------------------------------------------------------- push wording
CREATE TABLE IF NOT EXISTS push_templates (
  id BIGSERIAL PRIMARY KEY,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  -- Short, for a notification shade. Same wording as email_templates.subject.
  title TEXT NOT NULL,
  -- Shorter still. The wording SMS used to carry: {ref}, and {amount} where a status has one.
  body TEXT NOT NULL,
  UNIQUE (language, status)
);

DO $$
BEGIN
  IF to_regclass('public.sms_templates') IS NOT NULL
     AND to_regclass('public.email_templates') IS NOT NULL THEN
    INSERT INTO push_templates (language, status, title, body)
    SELECT e.language, e.status, e.subject, s.template
      FROM email_templates e
      JOIN sms_templates s ON s.language = e.language AND s.status = e.status
    ON CONFLICT (language, status) DO NOTHING;
  END IF;
END $$;

-- ------------------------------------------------------------------------- refuse to lose data
DO $$
DECLARE
  target RECORD;
  populated BOOLEAN;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES ('cases', 'citizen_mobile_plain'),
                          ('cases', 'twilio_message_sid'),
                          ('cases', 'citizen_nic_plain'),
                          ('users', 'mobile_number')) AS t(tbl, col)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = target.tbl AND column_name = target.col) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I IS NOT NULL)', target.tbl, target.col)
        INTO populated;
      IF populated THEN
        RAISE EXCEPTION 'Migration 034 refused: %.% still holds data. Export or clear it deliberately first.',
          target.tbl, target.col;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------- drop SMS objects
DROP TABLE IF EXISTS sms_templates;
ALTER TABLE cases DROP COLUMN IF EXISTS citizen_mobile_plain;
ALTER TABLE cases DROP COLUMN IF EXISTS twilio_message_sid;
ALTER TABLE cases DROP COLUMN IF EXISTS citizen_nic_plain;
ALTER TABLE users DROP COLUMN IF EXISTS mobile_number;
