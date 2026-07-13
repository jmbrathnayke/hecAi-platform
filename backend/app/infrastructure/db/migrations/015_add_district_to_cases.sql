-- Migration 015: real district capture on cases (Story 5.2 scope addition, PO-ratified
-- 2026-07-13). ds_division_id already exists (migration 010) but nothing populates it;
-- this adds the missing district column alongside it. Both stay nullable -- the picker
-- built in Task 7 is additive, never a hard submit gate.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS district TEXT;
