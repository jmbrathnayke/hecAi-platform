-- Migration 030: email_templates table (email status notifications).
--
-- Mirrors sms_templates (migration 019) deliberately: same 5 FR-6.2 status values x 3 languages,
-- and the core sentence of each body is the sms_templates wording VERBATIM, so the SMS text, the
-- email text and the public status page can never disagree on terminology. Email adds a subject
-- line and one extra sentence, which is the only reason this is a separate table rather than an
-- extra column on sms_templates -- an SMS has no subject, and widening that table would leave a
-- column that is meaningless for every row it already holds.
--
-- Placeholders: {ref} (all statuses) and {amount} (Approved only), substituted by plain string
-- replace in email_service.py -- not str.format(), so an unused {amount} in a non-Approved
-- template never raises a KeyError. Same rule as notification_service.py.
--
-- 'Submitted' doubles as the Proof of Claim email: {ref} is the PoC reference, which is what the
-- citizen needs to use the public status page (FR-6.1).
--
-- si/ta REVIEW STATUS: the core sentences carry over from migration 019 and inherit its review
-- state. The added second sentence and all subject lines are NEW and drafted here -- flag them
-- for native-speaker review before production, exactly as 019 flagged 'Payment Processed'.

CREATE TABLE IF NOT EXISTS email_templates (
  id BIGSERIAL PRIMARY KEY,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE (language, status)
);

INSERT INTO email_templates (language, status, subject, body) VALUES
  ('en', 'Submitted', 'HEC claim {ref} — submitted',
   'Your HEC claim {ref} has been submitted. We will notify you of any updates.

Keep this reference number. You can check your claim status at any time using it, without signing in.'),
  ('en', 'Under Review', 'HEC claim {ref} — under review',
   'Your HEC claim {ref} is now under review.

You can check your claim status at any time using this reference number.'),
  ('en', 'Approved', 'HEC claim {ref} — approved',
   'Your HEC claim {ref} has been approved. Approved amount: LKR {amount}.

You can check your claim status at any time using this reference number.'),
  ('en', 'Rejected', 'HEC claim {ref} — rejected',
   'Your HEC claim {ref} has been rejected. Contact your local DWC office for details.

You can check your claim status at any time using this reference number.'),
  ('en', 'Payment Processed', 'HEC claim {ref} — payment processed',
   'Payment for your HEC claim {ref} has been processed.

You can check your claim status at any time using this reference number.'),

  ('si', 'Submitted', 'HEC හිමිකම් පත්‍රය {ref} — ඉදිරිපත් කරන ලදී',
   'ඔබගේ HEC හිමිකම් පත්‍රය {ref} ඉදිරිපත් කර ඇත.

මෙම යොමු අංකය සුරකින්න. පිවිසීමකින් තොරව, ඕනෑම වේලාවක එය භාවිතයෙන් ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('si', 'Under Review', 'HEC හිමිකම් පත්‍රය {ref} — සමාලෝචනය වෙමින්',
   'ඔබගේ HEC හිමිකම් පත්‍රය {ref} සමාලෝචනය වෙමින් පවතී.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('si', 'Approved', 'HEC හිමිකම් පත්‍රය {ref} — අනුමත කරන ලදී',
   'ඔබගේ HEC හිමිකම් පත්‍රය {ref} අනුමත කර ඇත. අනුමත මුදල: රු. {amount}.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('si', 'Rejected', 'HEC හිමිකම් පත්‍රය {ref} — ප්‍රතික්ෂේප කරන ලදී',
   'ඔබගේ HEC හිමිකම් පත්‍රය {ref} ප්‍රතික්ෂේප කර ඇත. වැඩි විස්තර සඳහා ඔබගේ ප්‍රාදේශීය වනජීවී කාර්යාලය අමතන්න.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),
  ('si', 'Payment Processed', 'HEC හිමිකම් පත්‍රය {ref} — ගෙවීම සිදු කරන ලදී',
   'ඔබගේ HEC හිමිකම් පත්‍රය {ref} සඳහා ගෙවීම සිදු කර ඇත.

මෙම යොමු අංකය භාවිතයෙන් ඕනෑම වේලාවක ඔබගේ හිමිකම් පත්‍රයේ තත්ත්වය පරීක්ෂා කළ හැකිය.'),

  ('ta', 'Submitted', 'HEC கோரிக்கை {ref} — சமர்ப்பிக்கப்பட்டது',
   'உங்கள் HEC கோரிக்கை {ref} சமர்ப்பிக்கப்பட்டது.

இந்த குறிப்பு எண்ணைப் பாதுகாக்கவும். உள்நுழையாமல், எந்த நேரத்திலும் அதைப் பயன்படுத்தி உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'),
  ('ta', 'Under Review', 'HEC கோரிக்கை {ref} — மறுஆய்வில்',
   'உங்கள் HEC கோரிக்கை {ref} தற்போது மறுஆய்வில் உள்ளது.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'),
  ('ta', 'Approved', 'HEC கோரிக்கை {ref} — அங்கீகரிக்கப்பட்டது',
   'உங்கள் HEC கோரிக்கை {ref} அங்கீகரிக்கப்பட்டது. அங்கீகரிக்கப்பட்ட தொகை: ரூ. {amount}.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'),
  ('ta', 'Rejected', 'HEC கோரிக்கை {ref} — நிராகரிக்கப்பட்டது',
   'உங்கள் HEC கோரிக்கை {ref} நிராகரிக்கப்பட்டது. விவரங்களுக்கு உங்கள் உள்ளூர் DWC அலுவலகத்தை தொடர்பு கொள்ளவும்.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.'),
  ('ta', 'Payment Processed', 'HEC கோரிக்கை {ref} — கட்டணம் செயலாக்கப்பட்டது',
   'உங்கள் HEC கோரிக்கை {ref} க்கான கட்டணம் செயலாக்கப்பட்டது.

இந்த குறிப்பு எண்ணைப் பயன்படுத்தி எந்த நேரத்திலும் உங்கள் கோரிக்கையின் நிலையைச் சரிபார்க்கலாம்.')
ON CONFLICT (language, status) DO NOTHING;
