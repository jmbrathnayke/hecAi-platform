"""Refresh the `users` directory from Supabase.

    python -m scripts.sync_users            # sync
    python -m scripts.sync_users --dry-run  # show what would change, write nothing

WHAT THIS IS FOR. `audit_log.actor_id` and `households.registrant_uid` hold Supabase uids and
nothing in the database can resolve them to a person. Answering "who approved this case" or "how
many accounts exist, with what roles" meant an admin API call against Supabase that cannot be joined
against any platform table. This projects those accounts into `users` so that join exists.

*** THIS IS A PROJECTION, NOT AN AUTHORITY. ***
Authorization reads the role out of the signature-verified JWT (middleware/auth.py) and must never
read it from here. If a row disagrees with a token, the token wins. A row going stale, or missing
entirely, must never grant or deny anything — which is exactly why it is safe to refresh this table
on demand rather than keeping it transactionally in step.

NO PASSWORDS. Supabase holds them bcrypt-hashed, sign-in is a browser→Supabase call the backend
never sees, and nothing here needs them. Copying a credential into a second store would add an
exposure surface in exchange for nothing.

DELETIONS ARE APPLIED. An account removed from Supabase has its row removed here too, because a
directory that still lists a departed officer is worse than no directory: the one question it exists
to answer -- "who has access" -- would be answered wrongly.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

import psycopg2
from dotenv import load_dotenv

PER_PAGE = 200
AUTHZ_CLAIM = "app_metadata"


def _fetch_accounts(base, key):
    """Every account, following pagination. Returns [] on an API failure rather than a partial
    page: syncing half the directory and deleting the rest would be worse than not syncing."""
    out = []
    page = 1
    while True:
        req = urllib.request.Request(
            f"{base}/auth/v1/admin/users?per_page={PER_PAGE}&page={page}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=60) as res:
            batch = json.load(res).get("users", [])
        out.extend(batch)
        if len(batch) < PER_PAGE:
            return out
        page += 1


def _shape(account):
    """-> the row this account projects to. Reads only app_metadata, which is service-role-writable
    and therefore the same claim the guards trust; user_metadata is client-writable and ignored."""
    meta = account.get(AUTHZ_CLAIM) or {}
    role = meta.get("role") or "citizen"
    divisions = meta.get("assigned_divisions")
    return {
        "uid": account["id"],
        "email": account.get("email"),
        "role": role,
        # Kept in the columns the claim actually fits: the administrator's district is a NAME, not
        # the legacy bigint `district_id` that migration 005 declared (see migration 037).
        "district_name": meta.get("district_id"),
        "ds_division": meta.get("ds_division"),
        "assigned_divisions": [d for d in divisions if isinstance(d, str)]
                              if isinstance(divisions, list) else None,
        "confirmed": account.get("email_confirmed_at"),
        "last_sign_in": account.get("last_sign_in_at"),
    }


def main():
    parser = argparse.ArgumentParser(description="Refresh the users directory from Supabase.")
    parser.add_argument("--dry-run", action="store_true", help="report changes, write nothing")
    args = parser.parse_args()

    load_dotenv()
    base = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    database_url = os.getenv("DATABASE_URL")
    if not base or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    if not database_url:
        sys.exit("DATABASE_URL is required.")

    try:
        accounts = _fetch_accounts(base, key)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
        sys.exit(f"Could not read the account list from Supabase: {exc}")
    rows = [_shape(a) for a in accounts]
    live_uids = [r["uid"] for r in rows]

    conn = psycopg2.connect(database_url)
    with conn, conn.cursor() as cur:
        cur.execute("SELECT supabase_uid::text FROM users")
        existing = {r[0] for r in cur.fetchall()}
        added = [r for r in rows if r["uid"] not in existing]
        stale = existing - set(live_uids)

        if args.dry_run:
            print(f"would add {len(added)}, refresh {len(rows) - len(added)}, remove {len(stale)}")
        else:
            for r in rows:
                cur.execute(
                    """INSERT INTO users (supabase_uid, role, email, district_name, ds_division,
                                          assigned_divisions, email_confirmed_at, last_sign_in_at,
                                          synced_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
                       ON CONFLICT (supabase_uid) DO UPDATE
                         SET role = EXCLUDED.role,
                             email = EXCLUDED.email,
                             district_name = EXCLUDED.district_name,
                             ds_division = EXCLUDED.ds_division,
                             assigned_divisions = EXCLUDED.assigned_divisions,
                             email_confirmed_at = EXCLUDED.email_confirmed_at,
                             last_sign_in_at = EXCLUDED.last_sign_in_at,
                             synced_at = now()""",
                    (r["uid"], r["role"], r["email"], r["district_name"], r["ds_division"],
                     r["assigned_divisions"], r["confirmed"], r["last_sign_in"]),
                )
            if stale:
                cur.execute("DELETE FROM users WHERE supabase_uid::text = ANY(%s)", (list(stale),))

        cur.execute("SELECT role, count(*) FROM users GROUP BY role ORDER BY count(*) DESC")
        by_role = cur.fetchall()
    conn.close()

    verb = "would be" if args.dry_run else "now"
    print(f"\naccounts in Supabase : {len(rows)}")
    print(f"added                : {len(added)}")
    print(f"removed (gone)       : {len(stale)}")
    print(f"\ndirectory {verb}:")
    for role, count in by_role:
        print(f"   {role:<14}{count}")


if __name__ == "__main__":
    main()
