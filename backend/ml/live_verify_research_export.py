"""Live verification of Story 7.3's research export SQL against real dev Neon.

Read-only proof + a ROLLED-BACK write test. Nothing is committed.
"""
import os, sys
from pathlib import Path

# Anchor everything to THIS file, never the cwd. The original wrote abspath("__file__") -- the
# dunder as a string literal, a notebook copy-paste artifact -- which resolved against whatever
# directory you happened to be standing in, so the README's documented invocation from the repo
# root raised ModuleNotFoundError. Same reason .env is resolved here rather than passed as ".env".
_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import psycopg2
from dotenv import load_dotenv
load_dotenv(_BACKEND / ".env")

# Sinhala district/division names are printed below (check L). Windows consoles default to
# cp1252, which cannot encode them: on a redirected run the script died with UnicodeEncodeError
# at check L -- BEFORE the PII check -- and exited 1. Reconfigure before any print.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from app.api.v1.research import _RESEARCH_SELECT, _RESEARCH_COUNT, _row_to_dict

import socket as _s, re as _re
u = os.environ["DATABASE_URL"]
_h = _re.search(r"@([^/:?]+)", u).group(1)
_ip = sorted({i[4][0] for i in _s.getaddrinfo(_h, 5432, _s.AF_INET)})[0]
conn = psycopg2.connect(u, hostaddr=_ip, connect_timeout=30)
print("connected via IPv4", _ip)
try:
    # ---------- 1. read-only: is the SQL valid Postgres, and is the contract 15 columns?
    with conn.cursor() as cur:
        cur.execute(_RESEARCH_COUNT)
        print("A. COUNT query valid. existing inference rows joined to cases:", cur.fetchone()[0])
        cur.execute(_RESEARCH_SELECT, (5,))
        print("B. SELECT valid. columns returned:", len(cur.description))
        print("   names:", [d.name for d in cur.description])
        rows = cur.fetchall()
        print("   sample rows fetched:", len(rows))
        for r in rows[:2]:
            print("   ->", _row_to_dict(r))
    conn.rollback()

    # ---------- 2. rolled-back write: fan-out, null-estimate, timezone
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO cases (offline_id, canonical_id, damage_category, district,
                                          ds_division_id, status, approved_amount)
                       VALUES (gen_random_uuid(), 'HEC-TEST-7301', 'property', 'අනුරාධපුරය',
                               'ඉපලෝගම', 'Approved', 90000.00) RETURNING id""")
        case_a = cur.fetchone()[0]
        cur.execute("""INSERT INTO cases (offline_id, canonical_id, damage_category, district,
                                          status)
                       VALUES (gen_random_uuid(), 'HEC-TEST-7302', 'crop', 'කොළඹ', 'Submitted')
                       RETURNING id""")
        case_b = cur.fetchone()[0]

        # case_a gets TWO inference rows (AI result + officer override) in ONE transaction --
        # now() is transaction-stable, so both share created_at. This is the exact condition
        # that made 7.2 add an id tiebreaker.
        cur.execute("""INSERT INTO inference_log (case_id, model_type, model_version,
                          input_features, prediction, confidence, was_overridden,
                          override_reason, override_category)
                       VALUES (%s,'mobilenetv2','1.0.0',
                               '{"offline_id":"x","officer_id":"OFFICER-SECRET-123"}'::jsonb,
                               'crop_damage', 0.5500, false, NULL, NULL)""", (case_a,))
        cur.execute("""INSERT INTO inference_log (case_id, model_type, model_version,
                          input_features, prediction, confidence, was_overridden,
                          override_reason, override_category)
                       VALUES (%s,'mobilenetv2','1.0.0',
                               '{"offline_id":"x","officer_id":"OFFICER-SECRET-123"}'::jsonb,
                               'crop_damage', 0.9100, true,
                               'citizen Nimal Perera confirmed it was a fence', 'property_damage')""",
                    (case_a,))
        cur.execute("""INSERT INTO inference_log (case_id, model_type, model_version,
                          input_features, prediction, confidence)
                       VALUES (%s,'random_forest','v2','{}'::jsonb,'property_damage',NULL)""",
                    (case_b,))
        cur.execute("""INSERT INTO compensation_estimates (case_id, amount_lkr, raw_estimate_lkr,
                          capped, feature_values_json, model_version)
                       VALUES (%s, 125000.00, 130000.00, true, '{}'::jsonb,
                               'rf_compensation_v2')""", (case_a,))

        # _RESEARCH_SELECT is "ORDER BY il.id LIMIT %s" -- ASCENDING. The rows just planted carry
        # the HIGHEST ids, so a fixed LIMIT 1000 drops them the moment inference_log outgrows the
        # window. That failed silently in the worst possible way: `mine` came back empty, the
        # b_rows[0] lookups below raised IndexError, and -- if they had not -- the PII check greps
        # repr(mine), so every PII assertion would have reported present=False and PASSED without
        # inspecting a single row. Size the limit from the live count so the real query is
        # exercised unmodified and every planted row is inside the window. (Fine at dev scale;
        # this script is a schema proof, not a load test.)
        cur.execute(_RESEARCH_COUNT)
        total = cur.fetchone()[0]
        cur.execute(_RESEARCH_SELECT, (total,))
        got = [_row_to_dict(r) for r in cur.fetchall()]
        mine = [g for g in got if g["case_canonical_id"] in ("HEC-TEST-7301", "HEC-TEST-7302")]

        a_rows = [g for g in mine if g["case_canonical_id"] == "HEC-TEST-7301"]
        b_rows = [g for g in mine if g["case_canonical_id"] == "HEC-TEST-7302"]

        # Fail loudly rather than vacuously. Everything below -- the fan-out count, the null
        # checks, and above all the PII grep -- is only meaningful if the planted rows are
        # actually here. An empty `mine` must never read as "all checks passed".
        if len(a_rows) != 2 or len(b_rows) != 1:
            raise SystemExit(
                f"Planted rows not found in export window (a={len(a_rows)} expected 2, "
                f"b={len(b_rows)} expected 1, total joined rows={total}). "
                f"Every check below would have passed vacuously -- aborting."
            )
        print("\nC. fan-out preserved (2 inference rows -> 2 export rows):", len(a_rows) == 2, f"(got {len(a_rows)})")
        print("D. confidences kept distinct (no LATERAL collapse):",
              sorted(x["confidence"] for x in a_rows))
        print("E. override flags:", sorted(x["was_overridden"] for x in a_rows))
        print("F. null estimate stays null (not 0.0):", b_rows[0]["compensation_estimate_lkr"] is None,
              "->", repr(b_rows[0]["compensation_estimate_lkr"]))
        print("G. null confidence stays null:", repr(b_rows[0]["confidence"]))
        print("H. approved_amount:", a_rows[0]["approved_amount"], "| estimate:", a_rows[0]["compensation_estimate_lkr"])
        print("I. created_at offset-free UTC:", repr(a_rows[0]["created_at"]))
        print("J. ground_truth (expect None everywhere):", {x["ground_truth"] for x in mine})
        print("K. model_type separation:", {x["model_type"] for x in mine})
        print("L. sinhala district/division survive:", a_rows[0]["district"], "/", a_rows[0]["ds_division_id"])

        blob = repr(mine)
        print("\nM. PII LEAK CHECK on real rows:")
        for token in ("OFFICER-SECRET-123", "officer_id", "input_features", "override_reason",
                      "Nimal Perera", "gps_lat"):
            print(f"   {token:22s} present={token in blob}")
finally:
    conn.rollback()
    conn.close()
    print("\nROLLED BACK - nothing committed.")
