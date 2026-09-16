"""Apply migrations 029-031 (notification channels) to the configured database.

    python -m scripts.apply_notification_migrations            # dry run: show what would change
    python -m scripts.apply_notification_migrations --apply    # do it

Follows the precedent recorded for migrations 023-028 on 2026-08-26: ONE transaction, verified
in-transaction BEFORE commit, then check_migration_parity --strict as the independent confirmation.
There is no migration runner in this project by design (see check_migration_parity's docstring) --
applying by hand keeps a human in the loop. This script is that hand, not a runner: it applies one
named, reviewed set and refuses to guess at anything else.

SAFE TO RE-RUN. Every statement in 029-031 is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, and the
verification below asserts the end state rather than the change, so a second run is a no-op that
still reports success.
"""
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(dotenv_path=".env")

MIGRATIONS = ["029_add_contact_email_to_households.sql",
              "030_create_email_templates_table.sql",
              "031_create_push_subscriptions_table.sql"]

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "app" / "infrastructure" / "db" / "migrations"

# What must be true after the transaction. Asserted before COMMIT, so a migration that ran without
# producing what it claims rolls the whole set back rather than leaving the schema half-changed.
EXPECTED_COLUMNS = [("households", "contact_email")]
EXPECTED_TABLES = ["email_templates", "push_subscriptions"]
EXPECTED_ROWS = [("email_templates", 15)]  # 5 statuses x 3 languages


def verify(cur):
    problems = []

    for table, column in EXPECTED_COLUMNS:
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            " WHERE table_name = %s AND column_name = %s",
            (table, column),
        )
        if cur.fetchone() is None:
            problems.append(f"column {table}.{column} is missing")
        else:
            print(f"  ok  column  {table}.{column}")

    for table in EXPECTED_TABLES:
        cur.execute("SELECT to_regclass(%s)", (f"public.{table}",))
        if cur.fetchone()[0] is None:
            problems.append(f"table {table} is missing")
        else:
            print(f"  ok  table   {table}")

    for table, minimum in EXPECTED_ROWS:
        cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 - table names are literals above
        count = cur.fetchone()[0]
        if count < minimum:
            problems.append(f"{table} holds {count} rows, expected at least {minimum}")
        else:
            print(f"  ok  seed    {table}: {count} rows")

    return problems


def main():
    apply = "--apply" in sys.argv

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set in backend/.env")

    statements = []
    for name in MIGRATIONS:
        path = MIGRATIONS_DIR / name
        if not path.exists():
            sys.exit(f"missing migration file: {path}")
        statements.append((name, path.read_text(encoding="utf-8")))

    print(f"{len(statements)} migrations to apply:")
    for name, _ in statements:
        print(f"  {name}")
    print()

    if not apply:
        print("DRY RUN — nothing was sent to the database.")
        print("Re-run with --apply to execute.")
        return

    conn = psycopg2.connect(url, connect_timeout=30)
    try:
        with conn:  # commits on clean exit, rolls back on any exception
            with conn.cursor() as cur:
                for name, sql in statements:
                    cur.execute(sql)
                    print(f"  applied {name}")
                print("\nverifying before commit:")
                problems = verify(cur)
                if problems:
                    print()
                    for problem in problems:
                        print(f"  FAIL {problem}")
                    raise SystemExit("verification failed — the transaction was rolled back, "
                                     "nothing was changed.")
        print("\ncommitted.")
    finally:
        conn.close()

    print("\nNow run the independent check:")
    print("  python -m scripts.check_migration_parity --strict")


if __name__ == "__main__":
    main()
