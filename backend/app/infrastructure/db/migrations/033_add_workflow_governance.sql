-- Migration 033: human-in-the-loop workflow governance (officer assessment, DS final decision).
--
-- WHAT THIS RECORDS. The intended claim lifecycle is
--
--     citizen report -> area DWC officer reviews THAT case -> officer-side MobileNetV2 assessment
--       -> AI-assisted Random Forest estimate -> DWC administrator approval
--       -> Divisional Secretariat MANUAL final compensation decision -> payment authorisation
--
-- Until now the schema could not express the two human checkpoints in the middle of that chain:
-- nothing recorded which officer took responsibility for a citizen's case or when it was verified,
-- and the only amount on a case was the administrator's (approved_amount). The DS office could
-- release a payment but could not decide it, so the AI-assisted estimate flowed through the
-- administrator's approval straight into the payment record with no final human decision by the
-- office that pays.
--
-- WHY COLUMNS ON `cases` RATHER THAN NEW TABLES. Each checkpoint happens at most once per case at a
-- time and is read on every case view; the full history of every change is already carried by the
-- append-only, hash-chained audit_log (each write below is paired with an audit event in code).
-- A second table would duplicate that trail without adding information.
--
-- STATUS VOCABULARY IS UNCHANGED. The five FR-6.2 statuses (Submitted, Under Review, Approved,
-- Rejected, Payment Processed) remain the only values of cases.status, so every existing filter,
-- KPI and template keeps working. The finer stages ("officer assessment complete", "DS final
-- decision recorded") are derived from these timestamps, not stored as new statuses.
--
-- NO PERSONAL DATA. Officer and DS ids are Supabase account ids -- the same values already written
-- to audit_log.actor_id. Amounts and reasons are decisions, not citizen identity.
--
-- NO PHOTO STORAGE. The officer's assessment image is classified on-device and never uploaded;
-- only the classification result reaches the server (inference_log, migration 006).
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT) and additive: no existing column is altered or dropped.
-- Rollback, if ever required: DROP the eight columns and the index below, DELETE the two added
-- template statuses, and restore the 'Approved' template rows from migrations 019 and 030.

-- One ALTER per column, not one ALTER with eight ADD clauses: scripts/check_migration_parity.py
-- reads a single ADD COLUMN per statement, so the combined form would hide seven of these columns
-- from the deploy gate.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_officer_id TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS officer_review_started_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS officer_assessed_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS officer_assessed_by TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ds_final_amount NUMERIC(12,2);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ds_final_reason TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ds_final_by TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ds_final_at TIMESTAMPTZ;

-- Justified by the administrator's "responsible officer" filter (FR-5.1 organisation by officer).
-- Partial: most historical and seeded cases carry no assignment.
CREATE INDEX IF NOT EXISTS idx_cases_assigned_officer
  ON cases (assigned_officer_id)
  WHERE assigned_officer_id IS NOT NULL;

-- --------------------------------------------------------------------------------- templates
-- Two notification EVENTS that are not statuses. The template tables are keyed by (language,
-- status); these keys are notification event names that no case row ever carries, so they cannot
-- collide with the status vocabulary. Placeholders as in 019/030: {ref}, and {amount} for the
-- final decision only.
--
-- si/ta REVIEW STATUS: drafted here -- flag for native-speaker review, as 019 and 030 did.

INSERT INTO sms_templates (language, status, template) VALUES
  ('en', 'Assessment Complete', 'Your HEC claim {ref} has been verified by a DWC field officer and sent for administrative review.'),
  ('en', 'Final Decision', 'The Divisional Secretariat has confirmed the final compensation for HEC claim {ref}: LKR {amount}.'),
  ('si', 'Assessment Complete', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} වනජීවී ක්ෂේත්‍ර නිලධාරියෙකු විසින් තහවුරු කර පරිපාලන සමාලෝචනය සඳහා යොමු කර ඇත.'),
  ('si', 'Final Decision', 'HEC හිමිකම් පත්‍රය {ref} සඳහා අවසන් වන්දි මුදල ප්‍රාදේශීය ලේකම් කාර්යාලය විසින් තහවුරු කර ඇත: රු. {amount}.'),
  ('ta', 'Assessment Complete', 'உங்கள் HEC கோரிக்கை {ref} வனஜீவராசிகள் கள அலுவலரால் சரிபார்க்கப்பட்டு நிர்வாக மறுஆய்வுக்கு அனுப்பப்பட்டது.'),
  ('ta', 'Final Decision', 'HEC கோரிக்கை {ref} க்கான இறுதி இழப்பீட்டுத் தொகையை பிரதேச செயலகம் உறுதிப்படுத்தியுள்ளது: ரூ. {amount}.')
ON CONFLICT (language, status) DO NOTHING;

INSERT INTO email_templates (language, status, subject, body) VALUES
  ('en', 'Assessment Complete', 'HEC claim {ref} — officer verification complete',
   'A DWC field officer has verified your HEC claim {ref}. It is now with the DWC administrator for review.

You can check your claim status at any time using this reference number.'),
  ('en', 'Final Decision', 'HEC claim {ref} — final compensation decision',
   'The Divisional Secretariat has reviewed your HEC claim {ref} and confirmed the final compensation amount: LKR {amount}.

You can check your claim status at any time using this reference number.'),
  ('si', 'Assessment Complete', 'HEC හිමිකම් පත්‍රය {ref} — නිලධාරී තහවුරු කිරීම සම්පූර්ණයි',
   'වනජීවී ක්ෂේත්‍ර නිලධාරියෙකු ඔබගේ HEC හිමිකම් පත්‍රය {ref} තහවුරු කර ඇත. එය දැන් පරිපාලන සමාලෝචනය සඳහා ඇත.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('si', 'Final Decision', 'HEC හිමිකම් පත්‍රය {ref} — අවසන් වන්දි තීරණය',
   'ප්‍රාදේශීය ලේකම් කාර්යාලය ඔබගේ HEC හිමිකම් පත්‍රය {ref} සමාලෝචනය කර අවසන් වන්දි මුදල තහවුරු කර ඇත: රු. {amount}.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('ta', 'Assessment Complete', 'HEC கோரிக்கை {ref} — அலுவலர் சரிபார்ப்பு முடிந்தது',
   'வனஜீவராசிகள் கள அலுவலர் ஒருவர் உங்கள் HEC கோரிக்கை {ref} ஐ சரிபார்த்துள்ளார். அது இப்போது நிர்வாக மறுஆய்வில் உள்ளது.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'),
  ('ta', 'Final Decision', 'HEC கோரிக்கை {ref} — இறுதி இழப்பீட்டு முடிவு',
   'பிரதேச செயலகம் உங்கள் HEC கோரிக்கை {ref} ஐ மறுஆய்வு செய்து இறுதி இழப்பீட்டுத் தொகையை உறுதிப்படுத்தியுள்ளது: ரூ. {amount}.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.')
ON CONFLICT (language, status) DO NOTHING;

-- 'Approved' no longer quotes an amount. Administrative approval now forwards the case to the
-- Divisional Secretariat for the final compensation decision, so any amount at this stage is not
-- final -- telling a family "Approved amount: LKR X" and later confirming a different figure would
-- present a recommendation as a decision. The confirmed amount is sent by 'Final Decision' above.
UPDATE sms_templates SET template = 'Your HEC claim {ref} has been approved by DWC and sent to the Divisional Secretariat for the final compensation review.'
 WHERE language = 'en' AND status = 'Approved';
UPDATE sms_templates SET template = 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} වනජීවී දෙපාර්තමේන්තුව විසින් අනුමත කර අවසන් වන්දි සමාලෝචනය සඳහා ප්‍රාදේශීය ලේකම් කාර්යාලයට යොමු කර ඇත.'
 WHERE language = 'si' AND status = 'Approved';
UPDATE sms_templates SET template = 'உங்கள் HEC கோரிக்கை {ref} DWC யால் அங்கீகரிக்கப்பட்டு இறுதி இழப்பீட்டு மறுஆய்வுக்காக பிரதேச செயலகத்திற்கு அனுப்பப்பட்டது.'
 WHERE language = 'ta' AND status = 'Approved';

UPDATE email_templates SET body = 'Your HEC claim {ref} has been approved by the DWC administrator and sent to the Divisional Secretariat for the final compensation review.

You can check your claim status at any time using this reference number.'
 WHERE language = 'en' AND status = 'Approved';
UPDATE email_templates SET body = 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} වනජීවී දෙපාර්තමේන්තුව විසින් අනුමත කර අවසන් වන්දි සමාලෝචනය සඳහා ප්‍රාදේශීය ලේකම් කාර්යාලයට යොමු කර ඇත.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'
 WHERE language = 'si' AND status = 'Approved';
UPDATE email_templates SET body = 'உங்கள் HEC கோரிக்கை {ref} DWC யால் அங்கீகரிக்கப்பட்டு இறுதி இழப்பீட்டு மறுஆய்வுக்காக பிரதேச செயலகத்திற்கு அனுப்பப்பட்டது.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'
 WHERE language = 'ta' AND status = 'Approved';
