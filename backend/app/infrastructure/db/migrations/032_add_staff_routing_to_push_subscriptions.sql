-- Migration 032: staff routing for push_subscriptions (FR-6.4, staff-directed alerting).
--
-- WHAT WAS MISSING. Migration 031 built this table for ONE direction of travel: a case changes
-- status, and the household behind it is told. Every notification in the platform pointed that way
-- -- notify_status_change_all() is called from admin.py and ds.py, and all three of its channels
-- resolve their destination from the case's household. Nothing anywhere told a member of STAFF
-- that work had arrived for them.
--
-- The gap was worst at the Divisional Secretariat. The DWC administrator approves a claim; the DS
-- office is the one that pays it. Until now the DS officer learned that a payment was waiting only
-- by opening the dashboard and looking -- a poll, not a notification, in the one place where a
-- delay is a family waiting on money.
--
-- WHY COLUMNS HERE RATHER THAN A SECOND TABLE. A staff subscription and a citizen subscription are
-- the same object: an opaque endpoint plus the public half of a keypair, minted by the same browser
-- API, delivered by the same webpush_client, pruned by the same 404/410 rule. Splitting them would
-- duplicate that machinery and give the pruning logic two tables to keep in step. What differs is
-- only the routing key, so only the routing key is added.
--
-- STILL NO PERSONAL DATA, which is what let 031 avoid an NFR-3.1 amendment and is unchanged here.
-- staff_uid is a Supabase account id -- already the value written to audit_log.actor_id on every
-- action a staff member takes -- and staff_scope holds administrative area names (a district, a DS
-- division), which are public geography. Neither is a contact detail and neither reaches the person
-- by any route other than this one.
--
-- WHY staff_scope IS AN ARRAY. The three staff scopes are not the same shape. An administrator
-- holds one district (`district_id`), a DS officer holds one division (`ds_division`), but a field
-- officer holds SEVERAL divisions (`assigned_divisions`) -- see users.py::_validate_scope. Storing
-- the singular cases as one-element arrays makes every routing query the same shape:
--
--     WHERE staff_role = %s AND %s = ANY(staff_scope)
--
-- The alternative -- one row per division for an officer -- would make a single browser hold
-- several rows sharing one endpoint, which the UNIQUE(endpoint) constraint from 031 forbids.
--
-- ROWS ARE EITHER CITIZEN OR STAFF, never both: household_id/citizen_uid are set for a citizen and
-- staff_uid/staff_role/staff_scope for a member of staff. Not enforced by a CHECK constraint on
-- purpose -- the subscribe endpoint decides from the verified JWT role, and a constraint here would
-- turn a future third kind of subscriber into a migration rather than a branch.

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS staff_uid   TEXT,
  ADD COLUMN IF NOT EXISTS staff_role  TEXT,
  ADD COLUMN IF NOT EXISTS staff_scope TEXT[];

-- The send path is "given a case, find every staff device scoped to its division/district".
-- GIN, because the predicate is an array-containment test rather than an equality test.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff_scope
  ON push_subscriptions USING GIN (staff_scope)
  WHERE staff_scope IS NOT NULL;

-- Revocation path, and the guard on unsubscribe: remove one account's devices and no others.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff_uid
  ON push_subscriptions (staff_uid)
  WHERE staff_uid IS NOT NULL;
