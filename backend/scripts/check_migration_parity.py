"""Compare the repo's migration files against the schema actually applied (retro action #6).

    python -m scripts.check_migration_parity              # human-readable report
    python -m scripts.check_migration_parity --strict     # exit 1 on any drift (CI / deploy gate)

WHY THIS EXISTS. There is no migration runner in this project and no `schema_migrations` table --
migrations are applied by hand, and nothing anywhere records which ones have run. The only way to
know whether the deployed database matches the repo is to ask both and diff them, which is what
this does.

Migration 021 already proved the failure mode: a column existed in the repo and not in the
database, and the mismatch surfaced as a runtime 500 rather than as a deploy-time error. This
script is the gate that turns that class of problem back into a deploy-time error.

READ-ONLY. It opens a connection, runs catalog queries, and rolls back. It never applies a
migration -- deliberately. Applying by hand is a decision with a human in the loop (see
016's non-CONCURRENTLY index lock, and 012's hash-chain rewrite); this tool tells you what is
missing and stops there.

WHAT IT CHECKS, and what it deliberately does not:

  checked      tables, columns, and indexes declared with the CREATE/ALTER ... IF NOT EXISTS
               shapes this repo actually uses (verified against all 21 migrations)
  not checked  column TYPES, constraints, defaults, triggers, grants. A column that exists with
               the wrong type passes. Parsing enough SQL to compare types properly means either a
               real parser or a shadow database, and the failure this guards against is a
               MISSING object, not a subtly different one.

The unapplied-migration direction is the one that breaks production. The reverse direction --
objects in the database that no migration declares -- is reported too, because hand-applied
changes are exactly how a database drifts from the repo in a project with no runner.
"""
import argparse
import os
import re
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "app" / "infrastructure" / "db" / "migrations"

# Anchored to statement start so a table name inside a comment or a nested expression cannot
# match. re.M because these are multi-statement files; re.I because SQL keyword case varies.
_RE_CREATE_TABLE = re.compile(
    r"^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)", re.I | re.M)
_RE_ADD_COLUMN = re.compile(
    r"^\s*ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)",
    re.I | re.M)
_RE_CREATE_INDEX = re.compile(
    r"^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)",
    re.I | re.M)
# Removals (migration 034 retired SMS). A later migration that drops an object means the repo no
# longer declares it; without these the checker would demand objects the schema deliberately lost.
_RE_DROP_TABLE = re.compile(
    r"^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)", re.I | re.M)
_RE_DROP_COLUMN = re.compile(
    r"^\s*ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)",
    re.I | re.M)

# Postgres creates these itself; no migration declares them, and reporting them as drift would
# bury the real signal under noise on every run.
_IMPLICIT_INDEX_SUFFIXES = ("_pkey", "_key")

# Explicit, because naive singularisation gets "indexes" wrong -- `"indexes"[:-1]` is "indexe",
# which both misprints the label and silently breaks the sources lookup (every index reported its
# origin migration as "?"). Caught by running the checker against injected drift.
_SINGULAR = {"tables": "table", "columns": "column", "indexes": "index"}


def _strip_sql_comments(sql: str) -> str:
    """Remove `--` line comments before parsing.

    Not cosmetic. Several migrations document the statement they are NOT running -- 003 and 006
    carry commented-out `REVOKE`/`GRANT` lines, and others quote example DDL in prose. Parsing
    those as declarations would make this script demand objects no migration ever creates, and
    a checker that cries wolf gets muted. Block comments are not used anywhere in this corpus.
    """
    return re.sub(r"--[^\n]*", "", sql)


def parse_migrations():
    """-> (declared, sources): the objects the repo declares, and which file declared each."""
    declared = {"tables": set(), "columns": set(), "indexes": set()}
    sources: dict[tuple[str, str], str] = {}

    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        raise SystemExit(f"No migration files found under {MIGRATIONS_DIR}")

    for path in files:
        sql = _strip_sql_comments(path.read_text(encoding="utf-8"))
        for table in _RE_CREATE_TABLE.findall(sql):
            declared["tables"].add(table.lower())
            sources[("table", table.lower())] = path.name
        for table, column in _RE_ADD_COLUMN.findall(sql):
            key = f"{table.lower()}.{column.lower()}"
            declared["columns"].add(key)
            sources[("column", key)] = path.name
        for index in _RE_CREATE_INDEX.findall(sql):
            declared["indexes"].add(index.lower())
            sources[("index", index.lower())] = path.name
        # Applied after this file's creates: files run in filename order, and no migration here
        # creates and drops the same object in one file.
        for table in _RE_DROP_TABLE.findall(sql):
            name = table.lower()
            declared["tables"].discard(name)
            declared["columns"] = {c for c in declared["columns"] if not c.startswith(name + ".")}
        for table, column in _RE_DROP_COLUMN.findall(sql):
            declared["columns"].discard(f"{table.lower()}.{column.lower()}")

    return declared, sources, files


def read_applied(conn):
    """-> the tables, columns and indexes actually present in the `public` schema."""
    applied = {"tables": set(), "columns": set(), "indexes": set()}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            " WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
        applied["tables"] = {r[0].lower() for r in cur.fetchall()}

        cur.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            " WHERE table_schema = 'public'")
        applied["columns"] = {f"{t.lower()}.{c.lower()}" for t, c in cur.fetchall()}

        cur.execute("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        applied["indexes"] = {r[0].lower() for r in cur.fetchall()}

    return applied


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 if anything the repo declares is missing (deploy gate)")
    args = parser.parse_args()

    # Sinhala table/column data is not printed here, but district names appear in some error
    # paths and Windows consoles default to cp1252 -- see the same guard in backend/ml/.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    load_dotenv()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Source backend/.env or export it.")

    declared, sources, files = parse_migrations()
    print(f"Repo:     {len(files)} migration files ({files[0].name} … {files[-1].name})")
    print(f"Declares: {len(declared['tables'])} tables, {len(declared['columns'])} added columns, "
          f"{len(declared['indexes'])} indexes")

    conn = psycopg2.connect(url, connect_timeout=30)
    try:
        applied = read_applied(conn)
    finally:
        conn.rollback()
        conn.close()
    print(f"Database: {len(applied['tables'])} tables, {len(applied['columns'])} columns, "
          f"{len(applied['indexes'])} indexes\n")

    missing = {kind: sorted(declared[kind] - applied[kind]) for kind in declared}
    total_missing = sum(len(v) for v in missing.values())

    if total_missing:
        print("DECLARED IN REPO BUT MISSING FROM THE DATABASE")
        print("  (an unapplied migration -- this is the direction that breaks production)\n")
        for kind in ("tables", "columns", "indexes"):
            for name in missing[kind]:
                singular = _SINGULAR[kind]
                origin = sources.get((singular, name), "?")
                print(f"  missing {singular:7s} {name:52s} <- {origin}")
        print()
    else:
        print("✅ Every table, column and index the repo declares exists in the database.\n")

    # Reverse direction. Only tables and indexes: information_schema lists every column of every
    # table including ones created inline by CREATE TABLE, which this parser does not extract, so
    # a column-level reverse diff would be almost entirely false positives.
    extra_tables = sorted(applied["tables"] - declared["tables"])
    extra_indexes = sorted(
        i for i in applied["indexes"] - declared["indexes"]
        if not i.endswith(_IMPLICIT_INDEX_SUFFIXES))
    if extra_tables or extra_indexes:
        print("IN THE DATABASE BUT NOT DECLARED BY ANY MIGRATION")
        print("  (hand-applied change, or a migration deleted from the repo -- informational)\n")
        for t in extra_tables:
            print(f"  extra   table   {t}")
        for i in extra_indexes:
            print(f"  extra   index   {i}")
        print()

    if total_missing:
        print(f"DRIFT: {total_missing} declared object(s) missing. Apply the migrations listed "
              f"above, in filename order, before deploying.")
        if args.strict:
            sys.exit(1)
    else:
        print("Schema parity OK.")


if __name__ == "__main__":
    main()
