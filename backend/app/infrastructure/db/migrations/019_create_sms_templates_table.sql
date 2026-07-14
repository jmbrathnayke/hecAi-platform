-- Migration 019: sms_templates table (Story 5.6, FR-6.3). Seeded here (not left empty like
-- compensation_caps) -- this is our own content, not DWC policy data DWC hasn't supplied yet.
--
-- Seeds all 5 FR-6.2 status values x 3 languages (15 rows). si/ta wording for Submitted/Under
-- Review/Approved/Rejected is copied verbatim from frontend/messages/{si,ta}.json's existing
-- status.statusLabels block (Story 2.5) so the SMS text and the public status page never
-- disagree on terminology. "Payment Processed" has no existing translation anywhere in this
-- codebase (checked all 3 locale files) -- drafted here, flagged for native-speaker/DWC review
-- before production (see story 5.6 Dev Notes Open Question OQ-C).
--
-- Placeholders: {ref} (all statuses) and {amount} (Approved only), substituted via plain string
-- replace by notification_service.py -- not str.format(), so an unused {amount} in a
-- non-Approved template never raises a KeyError.

CREATE TABLE IF NOT EXISTS sms_templates (
  id BIGSERIAL PRIMARY KEY,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  template TEXT NOT NULL,
  UNIQUE (language, status)
);

INSERT INTO sms_templates (language, status, template) VALUES
  ('en', 'Submitted', 'Your HEC claim {ref} has been submitted. We will notify you of any updates.'),
  ('en', 'Under Review', 'Your HEC claim {ref} is now under review.'),
  ('en', 'Approved', 'Your HEC claim {ref} has been approved. Approved amount: LKR {amount}.'),
  ('en', 'Rejected', 'Your HEC claim {ref} has been rejected. Contact your local DWC office for details.'),
  ('en', 'Payment Processed', 'Payment for your HEC claim {ref} has been processed.'),
  ('si', 'Submitted', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} ඉදිරිපත් කර ඇත.'),
  ('si', 'Under Review', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} සමාලෝචනය වෙමින් පවතී.'),
  ('si', 'Approved', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} අනුමත කර ඇත. අනුමත මුදල: රු. {amount}.'),
  ('si', 'Rejected', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} ප්‍රතික්ෂේප කර ඇත. වැඩි විස්තර සඳහා ඔබගේ ප්‍රාදේශීය වනජීවී කාර්යාලය අමතන්න.'),
  ('si', 'Payment Processed', 'ඔබගේ HEC හිමිකම් පත්‍රය {ref} සඳහා ගෙවීම සිදු කර ඇත.'),
  ('ta', 'Submitted', 'உங்கள் HEC கோரிக்கை {ref} சமர்ப்பிக்கப்பட்டது.'),
  ('ta', 'Under Review', 'உங்கள் HEC கோரிக்கை {ref} தற்போது மறுஆய்வில் உள்ளது.'),
  ('ta', 'Approved', 'உங்கள் HEC கோரிக்கை {ref} அங்கீகரிக்கப்பட்டது. அங்கீகரிக்கப்பட்ட தொகை: ரூ. {amount}.'),
  ('ta', 'Rejected', 'உங்கள் HEC கோரிக்கை {ref} நிராகரிக்கப்பட்டது. விவரங்களுக்கு உங்கள் உள்ளூர் DWC அலுவலகத்தை தொடர்பு கொள்ளவும்.'),
  ('ta', 'Payment Processed', 'உங்கள் HEC கோரிக்கை {ref} க்கான கட்டணம் செயலாக்கப்பட்டது.')
ON CONFLICT (language, status) DO NOTHING;
