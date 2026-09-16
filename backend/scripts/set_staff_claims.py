"""Grant a Supabase user their staff authorization claims (role, divisions, district).

WHY THIS EXISTS. `app_metadata` is the only metadata field the API guards trust, because it is
writable *only* with the service-role key (see app/api/v1/middleware/auth.py). That is exactly
what makes it safe — and also why the Supabase dashboard renders it read-only. There is no UI
for this, so granting an officer or admin their role has to go through the Auth Admin API.

Credentials come from backend/.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), or from the shell
environment if you would rather export them there:

  set SUPABASE_URL=https://<project>.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=<service role key>

  python scripts/set_staff_claims.py --user <uuid> --role officer
  python scripts/set_staff_claims.py --user <uuid> --role officer --apply

Dry run by default: it prints the before/after app_metadata and writes nothing until --apply.

  --divisions-from FILE   JSON file supplying assigned_divisions (a bare list, or an object with
                          an "assigned_divisions" key). Division ids are Sinhala DS-division
                          names that must match `cases.ds_division_id` byte-for-byte, so reading
                          them from a generated file beats retyping them.
  --district ID           Sets district_id (admins are scoped to one district).
  --division NAME         Sets ds_division (a Divisional Secretariat officer is scoped to ONE
                          division, e.g. තලාව). Singular on purpose: unlike an officer's
                          assigned_divisions list, a DS officer belongs to one DS office.

THE SERVICE ROLE KEY IS NOT THE ANON KEY. It bypasses row-level security entirely. Pass it
through the environment, never a command-line argument (argv is world-readable in `ps`), and
never commit it.

AFTER RUNNING THIS, THE USER MUST GET A NEW TOKEN. Claims are baked into the JWT when it is
issued, so an existing session keeps its old (roleless) token until it refreshes or the user
signs in again — the change looks like it did nothing until then.
"""
import argparse
import json
import os
import sys

import requests
from dotenv import load_dotenv

# Read backend/.env like every other script in this directory. Without this the script demanded
# the credentials be exported into the shell first, while check_migration_parity, seed_research_data
# and setup_demo_accounts all read the same file automatically — so the one script that grants a
# role was also the one that appeared broken on a correctly configured machine. Explicit shell
# variables still win: load_dotenv does not override what is already set.
load_dotenv(dotenv_path=".env")

TIMEOUT = 30
VALID_ROLES = ("officer", "admin", "system_admin", "ds_officer")


def _env(name):
    value = os.getenv(name)
    if not value:
        sys.exit(f"ERROR: {name} is not set. See this script's docstring.")
    return value


def _load_divisions(path):
    # Every other failure in this script exits with a readable message; a missing or malformed
    # file should not be the one case that prints a traceback at an operator mid-deploy.
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        sys.exit(f"ERROR: cannot read {path}: {exc}")
    except json.JSONDecodeError as exc:
        sys.exit(f"ERROR: {path} is not valid JSON: {exc}")
    divisions = data.get("assigned_divisions") if isinstance(data, dict) else data
    if not isinstance(divisions, list) or not all(isinstance(d, str) for d in divisions):
        sys.exit(f"ERROR: {path} must contain a list of strings (or an object with that key).")
    if not divisions:
        # `all(...)` over an empty list is True, so this used to sail through and write
        # assigned_divisions: []. That fails closed (the officer sees only their own cases) but
        # silently, and it looks identical to "no cases in my division" — make it explicit.
        sys.exit(
            f"ERROR: {path} contains an empty division list. An officer with no divisions can "
            "see only cases they submitted themselves. Pass a non-empty list, or omit "
            "--divisions-from entirely if that is what you intend."
        )
    return divisions


def get_user(base, headers, user_id):
    resp = requests.get(f"{base}/auth/v1/admin/users/{user_id}", headers=headers, timeout=TIMEOUT)
    if resp.status_code == 404:
        sys.exit(f"ERROR: no user {user_id} in this project. Check the id and the project URL.")
    if resp.status_code in (401, 403):
        sys.exit(
            "ERROR: the Auth Admin API rejected the key. SUPABASE_SERVICE_ROLE_KEY must be the "
            "`service_role` secret from Settings > API — the anon/publishable key cannot write "
            "app_metadata."
        )
    resp.raise_for_status()
    return resp.json()


def main():
    # Sinhala DS-division names appear in --help, in the before/after claim dump, and in
    # several error strings; Windows consoles default to cp1252 and raise
    # UnicodeEncodeError on them. Same guard as scripts/check_migration_parity.py.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--user", required=True, help="Supabase user id (uuid)")
    parser.add_argument("--role", required=True, choices=VALID_ROLES)
    parser.add_argument("--divisions-from", help="JSON file of assigned_divisions")
    parser.add_argument("--district", help="district_id, for admins")
    parser.add_argument("--division",
                        help="ds_division, for ds_officer (ONE division, Sinhala name)")
    parser.add_argument("--apply", action="store_true", help="perform the write (default: dry run)")
    args = parser.parse_args()

    base = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    user = get_user(base, headers, args.user)
    current = user.get("app_metadata") or {}
    print(f"user   : {args.user}  <{user.get('email') or '(no email)'}>")
    print(f"before : {json.dumps(current, ensure_ascii=False)}\n")

    # Merge rather than replace: `provider`/`providers` are written by Supabase itself and other
    # claims may already be set. Only the keys named on the command line are touched.
    updated = dict(current)
    updated["role"] = args.role
    if args.divisions_from:
        updated["assigned_divisions"] = _load_divisions(args.divisions_from)
    if args.district:
        updated["district_id"] = args.district
    if args.division:
        updated["ds_division"] = args.division

    # Promoting officer -> admin must not leave the old division list behind. migration
    # 005_create_users_table.sql enforces CHECK (role = 'admin' => assigned_divisions IS NULL),
    # so a merge that keeps them produces app_metadata the durable `users` mirror would reject —
    # the two sources of truth silently disagreeing about what this person can read.
    # Story 8.5. A ds_officer is scoped by ONE division; migration 026's users_role_scope_check
    # rejects a ds_officer row carrying assigned_divisions or district_id, so leaving either behind
    # after a role change would make app_metadata and the durable `users` mirror disagree about
    # what this person can read — the same failure the admin branch below guards against.
    if args.role == "ds_officer":
        if args.divisions_from:
            sys.exit(
                "ERROR: --divisions-from is not valid with --role ds_officer. That flag sets an "
                "officer's assigned_divisions LIST; a DS officer has one division — use --division."
            )
        if args.district:
            sys.exit(
                "ERROR: --district is not valid with --role ds_officer. Districts scope admins; "
                "a DS officer is scoped to one DS division — use --division."
            )
        if not args.division and not current.get("ds_division"):
            sys.exit(
                "ERROR: --role ds_officer requires --division. Without it the guard returns 403 "
                "no_division_assigned on every request and the officer sees nothing."
            )
        for stale in ("assigned_divisions", "district_id"):
            if stale in updated:
                print(f"note   : dropping {stale} — it does not apply to role ds_officer.")
                updated.pop(stale)

    if args.role in ("admin", "system_admin") and "assigned_divisions" in updated:
        if args.divisions_from:
            sys.exit(
                f"ERROR: --divisions-from is not valid with --role {args.role}. Divisions scope "
                "officers; admins are scoped by --district."
            )
        print(
            f"note   : dropping assigned_divisions ({len(updated['assigned_divisions'])} entries)"
            f" — they do not apply to role {args.role}."
        )
        updated.pop("assigned_divisions")

    if args.role != "ds_officer" and "ds_division" in updated:
        print(f"note   : dropping ds_division — it does not apply to role {args.role}.")
        updated.pop("ds_division")

    print(f"after  : {json.dumps(updated, ensure_ascii=False)}\n")
    if updated == current:
        print("Nothing to change.")
        return

    if not args.apply:
        print("DRY RUN — nothing written. Re-run with --apply to perform this change.")
        return

    resp = requests.put(
        f"{base}/auth/v1/admin/users/{args.user}",
        headers=headers,
        json={"app_metadata": updated},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()

    # Read back rather than trusting the write response: this is an authorization change, so
    # confirm from the server what the guards will actually see.
    confirmed = (get_user(base, headers, args.user).get("app_metadata") or {})
    print(f"stored : {json.dumps(confirmed, ensure_ascii=False)}")

    # Verify EVERY key this run set, not just `role`. assigned_divisions is the one most likely
    # to be mangled in transit — the values are Sinhala DS-division names that must match
    # cases.ds_division_id byte-for-byte, and at least one carries a zero-width joiner. Checking
    # only the role meant a silently-dropped division list still printed "OK", and the officer
    # then saw an empty case list that looks exactly like "no cases in my area".
    mismatched = {
        key: {"expected": value, "stored": confirmed.get(key)}
        for key, value in updated.items()
        if confirmed.get(key) != value
    }
    if mismatched:
        print(f"\nmismatch: {json.dumps(mismatched, ensure_ascii=False, indent=2)}")
        sys.exit(
            "ERROR: the stored claims do not match what was sent. The user's authorization is "
            "now in an unknown state — re-run and inspect `stored` above before relying on it."
        )
    print("\nOK. The user must sign in again (or refresh) before the new claims appear in a token.")


if __name__ == "__main__":
    main()
