"""Move authorization claims from user_metadata to app_metadata for existing Supabase users.

WHY THIS EXISTS. Until 2026-08-11 the API guards read `role`, `district_id` and
`assigned_divisions` from `user_metadata`, which any authenticated client can rewrite through
`auth.updateUser()`. A citizen could therefore self-assign `system_admin` and export the whole
research corpus behind a perfectly valid Supabase signature. The guards now read `app_metadata`,
which only the service-role key can write. Existing users still carry their claims in the old
place, so their tokens authorize nothing until this script copies them across.

RUN IT BEFORE DEPLOYING THE GUARD CHANGE, or every officer and admin is locked out.

  set SUPABASE_URL=https://<project>.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=<service role key>

  python scripts/migrate_auth_metadata.py            # dry run, prints the plan
  python scripts/migrate_auth_metadata.py --apply    # actually writes

THE SERVICE ROLE KEY IS NOT THE ANON KEY. It bypasses row-level security entirely. Pass it
through the environment, never a command-line argument (argv is world-readable in `ps`), and
never commit it.

`--strip` additionally clears the three keys from user_metadata once they are safely copied.
Optional: nothing reads them any more, but leaving a stale `role: "admin"` visible to the
client invites someone to "fix" a future bug by reading it again.
"""
import argparse
import json
import os
import sys

import requests

AUTHZ_KEYS = ("role", "district_id", "assigned_divisions")
PAGE_SIZE = 200
TIMEOUT = 30


def _env(name):
    value = os.getenv(name)
    if not value:
        sys.exit(f"ERROR: {name} is not set. See this script's docstring.")
    return value


def list_users(base, headers):
    """Every user, following pagination. Supabase caps per_page, so do not assume one page."""
    users, page = [], 1
    while True:
        resp = requests.get(f"{base}/auth/v1/admin/users",
                            headers=headers, params={"page": page, "per_page": PAGE_SIZE},
                            timeout=TIMEOUT)
        resp.raise_for_status()
        batch = resp.json().get("users", [])
        users.extend(batch)
        if len(batch) < PAGE_SIZE:
            return users
        page += 1


def plan_for(user):
    """What needs copying for one user, or None if nothing does.

    A key already present in app_metadata is left alone and never overwritten from
    user_metadata -- app_metadata is the trusted side, so if the two disagree the trusted value
    wins. Reversing that would let a user who edited their own user_metadata before the
    migration overwrite the real one.
    """
    user_meta = user.get("user_metadata") or {}
    app_meta = user.get("app_metadata") or {}

    to_copy = {k: user_meta[k] for k in AUTHZ_KEYS
               if k in user_meta and k not in app_meta}
    conflicts = {k: (user_meta[k], app_meta[k]) for k in AUTHZ_KEYS
                 if k in user_meta and k in app_meta and user_meta[k] != app_meta[k]}
    return to_copy, conflicts


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true",
                        help="perform the writes (default is a dry run)")
    parser.add_argument("--strip", action="store_true",
                        help="also clear the copied keys from user_metadata")
    args = parser.parse_args()

    base = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    headers = {"apikey": key, "Authorization": f"Bearer {key}",
               "Content-Type": "application/json"}

    users = list_users(base, headers)
    print(f"{len(users)} user(s) in the project\n")

    changed = skipped = 0
    for user in users:
        uid, email = user["id"], user.get("email") or "(no email)"
        to_copy, conflicts = plan_for(user)

        for k, (from_user, from_app) in conflicts.items():
            print(f"  CONFLICT {email}: {k} is {from_user!r} in user_metadata but "
                  f"{from_app!r} in app_metadata -- keeping app_metadata")

        if not to_copy:
            skipped += 1
            continue

        changed += 1
        verb = "would copy" if not args.apply else "copying"
        print(f"  {verb} for {email} ({uid}): {json.dumps(to_copy, ensure_ascii=False)}")

        if not args.apply:
            continue

        payload = {"app_metadata": {**(user.get("app_metadata") or {}), **to_copy}}
        if args.strip:
            payload["user_metadata"] = {k: v for k, v in (user.get("user_metadata") or {}).items()
                                        if k not in AUTHZ_KEYS}
        resp = requests.put(f"{base}/auth/v1/admin/users/{uid}",
                            headers=headers, json=payload, timeout=TIMEOUT)
        if not resp.ok:
            # Keep going: one bad user must not leave the rest half-migrated with no report.
            print(f"    FAILED {resp.status_code}: {resp.text[:200]}")
            changed -= 1

    print(f"\n{changed} user(s) {'updated' if args.apply else 'would be updated'}, "
          f"{skipped} already correct or with no authorization claims")
    if not args.apply and changed:
        print("\nDry run only. Re-run with --apply to write.")
    if args.apply and changed:
        print("\nUsers must sign out and back in -- a JWT already issued still carries the old "
              "claims until it expires.")


if __name__ == "__main__":
    main()
