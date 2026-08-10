"""End-to-end scenario suite (Story 7.4, RER-4 / RER-7 server half).

Unlike every other test package here, these drive the real Flask routes against a REAL
Postgres. They are skipped unless HEC_SCENARIO_DB_URL is set — see conftest.py for why that is
a separate variable from DATABASE_URL.
"""
