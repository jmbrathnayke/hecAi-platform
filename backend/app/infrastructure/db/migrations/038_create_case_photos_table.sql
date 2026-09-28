-- Migration 038: case_photos — the photographic evidence a case rests on.
--
-- WHAT WAS MISSING, AND WHY IT LOOKED DELIBERATE. Until now no image reached this server at all.
-- Citizens captured 1–10 damage photos (frontend lib/indexeddb.ts `photo_blobs`) and officers
-- captured a verification photo, but both stayed in the browser: there was no bucket, no table, no
-- column and no endpoint. The UI explained the absence as a privacy property ("the family's
-- photographs stay on the phone"), and `BLOB_READ_WRITE_TOKEN` was struck from render.yaml on
-- 2026-08-13 with the note "Re-add it with the pipeline, not before". That is this pipeline.
--
-- The consequence of the gap was that an administrator approved, and a Divisional Secretariat paid,
-- a claim whose only evidence was a class label and a percentage. Nobody downstream of the field
-- officer could see what was photographed. A compensation decision that cannot be shown is not
-- auditable, and an appeal against it could not be examined at all.
--
-- THIS DOES NOT MOVE THE INFERENCE. MobileNetV2 still runs entirely in the officer's browser
-- (FR-2.1/2.2) on the officer's own photograph; the model input never leaves the device and no
-- image is sent anywhere to be classified. Storing a photograph as case EVIDENCE and running the
-- classifier ON-DEVICE are independent claims, and only the first changes here.
--
-- BYTES LIVE IN SUPABASE STORAGE, NOT IN POSTGRES. This table holds the reference; the object
-- itself is in a PRIVATE bucket reached with the service-role key, and readers are served
-- short-lived signed URLs (app/infrastructure/storage/photo_store.py). A bytea column would put
-- multi-megabyte blobs into every backup and into the same connection pool the workflow queries
-- use, for no gain.
--
-- PII. A photograph of a damaged home is personal data about the household that lives in it, more
-- revealing than any other column this system stores. Three controls follow from that and are
-- implemented in app/api/v1/case_photos.py rather than here: the bucket is private and never
-- served directly; every read is scoped by the caller's JWT exactly as the case itself is (an
-- officer sees their divisions, an administrator their district, a DS officer their division, a
-- citizen only their own household); and every upload and every signed-URL issue is written to
-- audit_log, so who looked at a family's photographs is answerable after the fact.

CREATE TABLE IF NOT EXISTS case_photos (
  id            BIGSERIAL PRIMARY KEY,
  case_id       BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- 'citizen'  — taken by the household when reporting; supports their Proof of Claim.
  -- 'officer'  — taken by the field officer at the site; this is the image MobileNetV2 classified
  --              on the officer's device, so it is the one the assessment actually rests on.
  source        VARCHAR(16) NOT NULL CHECK (source IN ('citizen', 'officer')),
  storage_path  TEXT NOT NULL UNIQUE,
  content_type  VARCHAR(64) NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0),
  -- SHA-256 of the bytes. Makes a re-uploaded photo (an offline retry that already succeeded, a
  -- citizen who taps submit twice) detectable instead of duplicated, and lets a stored object be
  -- shown to be the one that was uploaded -- which is what makes it evidence rather than a file.
  sha256        CHAR(64) NOT NULL,
  -- The Supabase auth uid of the uploader. NULL is not permitted: an unattributable photograph
  -- cannot be used to support or contest a payment.
  uploaded_by   UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every read is "the photos of this case", in upload order.
CREATE INDEX IF NOT EXISTS idx_case_photos_case_id ON case_photos (case_id, id);

-- One row per distinct image per case. A retried upload of the same bytes collides here and is
-- absorbed by the endpoint's ON CONFLICT DO NOTHING rather than producing a duplicate tile in the
-- administrator's gallery; two genuinely different photographs never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_photos_case_sha
  ON case_photos (case_id, sha256);

-- Append-only by convention, like audit_log (003) and inference_log (006). Run once per
-- environment with a superuser, after the app role exists:
--   REVOKE UPDATE, DELETE ON case_photos FROM <app_role>;
--   GRANT  INSERT, SELECT ON case_photos TO   <app_role>;
-- The ON DELETE CASCADE above is for a case that is itself removed (test fixtures, an erroneous
-- duplicate withdrawn before review); it is not a route for deleting evidence from a live case.
