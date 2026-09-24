-- Migration 036: the officer's crop assessment — crop type, affected area and damage extent.
--
-- WHY THESE THREE COLUMNS EXIST. MobileNetV2 answers "is this crop damage or property damage"; it
-- cannot answer "is this paddy or banana", and no classifier in this system can. Until now that did
-- not matter, because rf_compensation_v2 was fit on the historical DWC dataset whose damage_type
-- vocabulary is {death, injury, property} — it has no crop class at all, so every crop report was
-- collapsed onto "property" and priced by a model that had never seen a field. The synthetic crop
-- estimator (synthetic_crop_compensation_v1) covers that branch instead, and it needs inputs only a
-- person standing in the field can supply.
--
-- OFFICER-DECLARED, NOT AI-DERIVED. All three are entered by the officer during the assessment and
-- must be presented as such wherever they are shown. The AI's contribution to a crop case is the
-- damage classification and the routing decision it drives, not the crop identification.
--
-- NULLABLE, AND THE WHOLE POINT IS THE FALLBACK. Every case submitted before this migration, every
-- property case, and every crop case whose officer did not know the crop keeps NULL here and
-- continues down the existing rf_compensation_v2 path exactly as before. A partially filled
-- assessment degrades to the previous behaviour rather than to no estimate — see
-- compensation.py::_crop_inputs(), which re-validates all three server-side and falls back when any
-- one of them is missing or out of range.
--
-- NOT PII. Unlike households.address (035) or contact_email (029) these describe a field, not a
-- person, so they are safe for research exports and admin views.
--
-- crop_type is deliberately TEXT with no CHECK constraint: the allowed vocabulary is the five
-- classes the model was fit on, which belongs with the model artifact
-- (compensation.CROP_TYPES, mirrored in meta["crop_types"]) rather than frozen into the schema
-- where a retrained model with a sixth crop would require a migration to deploy.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS crop_type TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS affected_area_acres NUMERIC(10, 2);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS damage_extent_percent NUMERIC(5, 2);

-- Partial index: crop cases are the minority and the only rows any crop-specific query touches.
CREATE INDEX IF NOT EXISTS idx_cases_crop_type ON cases (crop_type) WHERE crop_type IS NOT NULL;
