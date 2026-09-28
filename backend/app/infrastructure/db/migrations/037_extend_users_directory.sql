-- Migration 037: make `users` a usable directory of every account on the platform.
--
-- WHAT THIS TABLE WAS, AND WHY IT WAS EMPTY. `users` was created in migration 005 as a staff
-- mirror, and then nothing ever wrote to it — the authorization decision went the other way. Every
-- guard reads the role out of `app_metadata` in the signature-verified JWT (middleware/auth.py), so
-- a row here grants nothing and its absence withholds nothing, and the provisioning API deliberately
-- declined to mirror into it (users.py, and R-20 in the risk register). The table sat with one
-- stale row while 23 accounts existed in Supabase.
--
-- WHAT IT IS NOW: a READ-ONLY DIRECTORY, not an authorization source. It answers "who has an
-- account, what role, which area, when did they join, have they confirmed their email" — questions
-- that currently require an admin API call against Supabase and cannot be joined against cases,
-- households or the audit log. That join is the whole point: `audit_log.actor_id` and
-- `households.registrant_uid` hold Supabase uids with nothing to resolve them to a name.
--
-- *** AUTHORIZATION STILL DOES NOT READ THIS TABLE, AND MUST NOT START. ***
-- The JWT remains the single source of truth. If a row here ever disagrees with the token, the
-- token wins — this is a projection of Supabase, refreshed by scripts/sync_users.py, never the
-- authority. A stale or missing row must never be able to grant or deny access.
--
-- NO PASSWORDS, EVER. Supabase holds them bcrypt-hashed and nothing here needs them: this table is
-- never consulted during sign-in (that is a browser→Supabase call the backend never sees). Copying
-- a credential into a second store would create an exposure surface in exchange for nothing, which
-- is the same reasoning NFR-3.2 applies to citizen contact data.
--
-- WHY `district_name` RATHER THAN REUSING `district_id`. The legacy column is a BIGINT foreign key
-- from a design that numbered districts; the administrator claim is the district NAME as a Sinhala
-- string, and admin.py compares it as `WHERE district = g.district_id`. Writing the claim into the
-- bigint would raise a type error on every administrator. The legacy column is left alone rather
-- than altered, because this migration must stay additive and nothing reads either one for access.
--
-- EMAIL IS PII, AND THIS ONE IS DIFFERENT FROM households.contact_email. That address belongs to a
-- citizen and is covered by the NFR-3.1 exception; this is the sign-in identifier of an account
-- holder, most of them staff. It must not appear in research exports (research.py) for the same
-- reason, and the directory endpoint is admin-gated.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS district_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;
-- When this row was last refreshed from Supabase. A stale timestamp is the signal that the
-- directory has drifted, which is information the table could not previously carry at all.
ALTER TABLE users ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

-- The uid is what audit_log.actor_id and households.registrant_uid actually hold, so it is the join
-- key and must be unique. Migration 005 declared it NOT NULL but not unique, which would let a
-- re-sync insert a second row for the same account and make the join ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_uid ON users (supabase_uid);

-- --------------------------------------------------------------------------------------------
-- The two CHECK constraints from migration 005 describe a staff mirror, and this is no longer one.
--
-- `users_role_check` allowed only officer/admin/ds_officer. A directory of everyone has to hold
-- citizens — they are the majority of accounts — and system_admin, which did not exist in 005.
--
-- `users_role_scope_check` is the harder one: it requires an administrator's row to carry a
-- non-null `district_id`, the legacy BIGINT. The administrator claim is a district NAME, which is
-- why `district_name` exists above; satisfying the old constraint would mean inventing a numeric id
-- that nothing issues. It also forbids a row with no scope at all, which is exactly what a citizen
-- and a system_admin are.
--
-- Both are DROPPED rather than rewritten, and the reasoning matters: this table is a projection of
-- Supabase, and Supabase is the authority on what shape a claim has. A constraint here that
-- disagreed with a claim Supabase legitimately holds would not protect anything — authorization
-- never reads this table — it would only make the sync fail and leave the directory stale, which is
-- the one failure mode a directory must not have.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_scope_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- Kept as a typo guard only: an unrecognised string here means the sync read something unexpected
-- out of app_metadata, and that is worth failing on. It grants nothing either way.
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('citizen', 'officer', 'admin', 'ds_officer', 'system_admin'));

-- Partial: an account with no email is a broken record, not a row anyone looks up by address.
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;
