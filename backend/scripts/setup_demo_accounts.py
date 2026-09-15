"""Create or update the staff accounts used to demonstrate each role.

    python -m scripts.setup_demo_accounts                 # dry run: show what would change
    python -m scripts.setup_demo_accounts --apply         # create/update the accounts
    python -m scripts.setup_demo_accounts --list          # show every account and its claims

WHY THIS EXISTS. Each role needs its own sign-in, because app_metadata.role holds ONE value: an
account is an officer or an administrator, never both. Demonstrating four roles therefore needs
four accounts, and creating them by hand through the dashboard means four signup flows, four email
confirmations and four separate runs of set_staff_claims.py.

This creates them with the Admin API instead: email + password, pre-confirmed (email_confirm=True,
so no inbox round-trip), with the role claims written in the same call. Google OAuth is not
involved, so signing in as a different role does not require a different Google account or a
different browser profile.

SCOPE VALUES MATTER. A district or division that holds no cases produces a dashboard that is
empty but not broken, which is indistinguishable from a bug during a demonstration. The defaults
below are chosen from divisions that actually carry seeded cases; --list prints the counts.

The passwords here are for a local demonstration against seeded data. They are not secrets and
must not be reused anywhere that holds real citizen data.
"""
import argparse
import os
import sys

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(dotenv_path=".env")

PASSWORD = "HecDemo!2026"

# (email, role, claims) — scopes chosen so each dashboard has rows to show.
ACCOUNTS = [
    ("ds@hec-demo.lk", "ds_officer", {"ds_division": "අම්බලන්තොට"}),
    ("admin@hec-demo.lk", "admin", {"district_id": "අනුරාධපුරය"}),
    ("officer@hec-demo.lk", "officer",
     {"assigned_divisions": ["අම්බලන්තොට", "හම්බන්තොට", "ලුණුගම්වෙහෙර"]}),
    ("research@hec-demo.lk", "system_admin", {}),
]


def admin_headers():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        sys.exit("SUPABASE_URL is not set in backend/.env")
    if not key:
        sys.exit(
            "SUPABASE_SERVICE_ROLE_KEY is not set in backend/.env.\n\n"
            "app_metadata is writable only with the service-role key — that restriction is what\n"
            "makes it the one claim source the API guards trust, and it is why the Supabase\n"
            "dashboard shows the field read-only.\n\n"
            "  Supabase Dashboard -> Settings -> API -> Project API keys -> service_role -> Reveal\n"
            "  backend/.env:  SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...\n\n"
            "Treat it like a database password: it bypasses every row-level policy."
        )
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def find_user(url, headers, email):
    """The Admin API has no email filter, so page until the address turns up."""
    page = 1
    while page <= 20:
        r = requests.get(f"{url}/auth/v1/admin/users", headers=headers,
                         params={"page": page, "per_page": 200}, timeout=30)
        if r.status_code != 200:
            sys.exit(f"admin API returned HTTP {r.status_code}: {r.text[:200]}")
        users = r.json().get("users", [])
        if not users:
            return None
        for u in users:
            if (u.get("email") or "").lower() == email.lower():
                return u
        page += 1
    return None


def list_accounts(url, headers):
    page, shown = 1, 0
    print(f"{'email':34s} {'role':14s} scope")
    print("-" * 88)
    while page <= 20:
        r = requests.get(f"{url}/auth/v1/admin/users", headers=headers,
                         params={"page": page, "per_page": 200}, timeout=30)
        users = r.json().get("users", [])
        if not users:
            break
        for u in users:
            meta = u.get("app_metadata") or {}
            role = meta.get("role")
            scope = (meta.get("ds_division") or meta.get("district_id")
                     or meta.get("assigned_divisions") or "")
            print(f"{(u.get('email') or '(no email)'):34s} {(role or '(none)'):14s} {scope}")
            shown += 1
        page += 1
    print(f"\n{shown} accounts")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write; otherwise dry run")
    parser.add_argument("--list", action="store_true", help="list accounts and claims, then exit")
    args = parser.parse_args()

    url, headers = admin_headers()

    if args.list:
        list_accounts(url, headers)
        return

    print(f"target: {url}")
    print(f"password for all demo accounts: {PASSWORD}")
    print()

    for email, role, claims in ACCOUNTS:
        meta = {"role": role, **claims}
        existing = find_user(url, headers, email)

        if not args.apply:
            state = "UPDATE" if existing else "CREATE"
            print(f"  [{state}] {email:26s} role={role:14s} {claims or ''}")
            continue

        if existing:
            r = requests.put(f"{url}/auth/v1/admin/users/{existing['id']}", headers=headers,
                             json={"app_metadata": meta, "password": PASSWORD}, timeout=30)
            action = "updated"
        else:
            r = requests.post(f"{url}/auth/v1/admin/users", headers=headers,
                              json={"email": email, "password": PASSWORD,
                                    # Pre-confirmed: the project has mailer_autoconfirm off, and a
                                    # demo account should not depend on an inbox round-trip.
                                    "email_confirm": True, "app_metadata": meta}, timeout=30)
            action = "created"

        if r.status_code not in (200, 201):
            print(f"  FAILED  {email}: HTTP {r.status_code} {r.text[:160]}")
            continue
        print(f"  {action:8s} {email:26s} role={role:14s} {claims or ''}")

    if not args.apply:
        print("\nDRY RUN — nothing was written. Re-run with --apply.")
    else:
        print("\nSign in with email + password on each portal:")
        print("  /officer/login   officer@hec-demo.lk")
        print("  /admin/login     admin@hec-demo.lk")
        print("  /ds/login        ds@hec-demo.lk")
        print(f"  password         {PASSWORD}")
        print("\nGoogle OAuth is not involved, so no browser profile juggling and no account picker.")


if __name__ == "__main__":
    main()
