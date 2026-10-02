-- Migration 040: cases.citizen_description -- the family's own words about the damage.
--
-- WHAT WAS LOST. Step 3 of the citizen report has always asked for an optional description of the
-- damage (up to 500 characters, app/[locale]/report/damage/page.tsx MAX_DESCRIPTION) and kept it in
-- the browser draft. Nothing ever sent it: lib/poc.ts buildCasePayload had no field for it and this
-- table had no column. So the field officer who verifies a claim, the administrator who approves it
-- and the Divisional Secretariat that pays it never read what the family wrote.
--
-- CASE DETAIL, NOT RESEARCH DATA. Free text written by a claimant can carry names, phone numbers or
-- anything else, so this column is shown only to the staff whose scope already covers the case
-- (officer_cases.py, admin.py, ds.py) and to nobody else: never on the public status page
-- (status.py), in the research export (research.py, explicit column list), in analytics, or in
-- infrastructure/export/report.py.
--
-- 1000 characters is twice the form's limit, so the CHECK only ever stops a client that skips the
-- form. The API trims anything longer rather than refusing the report: a 400 would leave an
-- offline report stuck in the citizen's outbox over a free-text field.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS citizen_description TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_citizen_description_length') THEN
    ALTER TABLE cases
      ADD CONSTRAINT cases_citizen_description_length
      CHECK (citizen_description IS NULL OR char_length(citizen_description) <= 1000);
  END IF;
END $$;
