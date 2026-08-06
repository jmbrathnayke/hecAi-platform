"""Tests for GET /api/v1/admin/export (Story 7.2, FR-7.2, NFR-3.3).

DB faked (no Postgres), same FakeConn/FakeCursor style as test_admin.py and
test_admin_analytics.py, scoped to this endpoint's own three queries: the COUNT for the audit
row, the unpaginated export SELECT (with the LATERAL latest-inference-row join), and the
audit_log INSERT.

The FakeConn here additionally supports `cursor(name=...)` (psycopg2 server-side/named cursor),
`fetchmany()` and `commit()`, because the CSV path streams rather than buffering -- see
admin.py::export_cases.
"""
import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any

import jwt
import pytest

from app import create_app
from app.infrastructure.export.report import CSV_COLUMNS

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256

DISTRICT_A = "අනුරාධපුරය"
DISTRICT_B = "කොළඹ"
DIVISION_A = "ඉපලෝගම"

# Every field name that must NEVER appear in an export (AC4/NFR-3.3). Asserted against the
# real header row rather than trusted by inspection.
PII_FIELDS = (
    "nic",
    "citizen_nic_plain",
    "submitter_identity_hash",
    "citizen_mobile_plain",
    "mobile",
    "gps_lat",
    "gps_lng",
)


def _token(sub="admin-1", role="admin", district_id=DISTRICT_A):
    claims = {"sub": sub, "user_metadata": {"role": role, "district_id": district_id}}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _case(
    id_,
    district,
    canonical_id=None,
    status="Submitted",
    submitted_at=None,
    damage_category="property",
    approved_amount=None,
    ds_division_id=None,
):
    return {
        "id": id_,
        "canonical_id": canonical_id or f"HEC-2026-{id_:04d}",
        "district": district,
        "status": status,
        "submitted_at": submitted_at or datetime(2026, 7, 5, 9, 0),
        "damage_category": damage_category,
        "approved_amount": approved_amount,
        "ds_division_id": ds_division_id,
    }


def _inference(case_id, confidence=0.9, was_overridden=False, created_at=None):
    return {
        "case_id": case_id,
        "confidence": confidence,
        "was_overridden": was_overridden,
        "created_at": created_at or datetime(2026, 7, 8, 10, 0, 0),
    }


class FakeCursor:
    def __init__(self, store, name=None):
        self.store = store
        self.name = name
        self.itersize = None
        self._rows = []
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _latest_inference(self, case_id):
        rows = [r for r in self.store["inference_log"] if r["case_id"] == case_id]
        if not rows:
            return None
        return sorted(rows, key=lambda r: r["created_at"], reverse=True)[0]

    def _matching(self, params):
        """Applies _build_conditions()'s filters in the order it emits them.

        params[0] is always district; the rest arrive in _build_conditions' fixed order
        (status, from, to, type, division) for whichever of them were supplied. The test
        harness reconstructs that by consuming the SQL text, so a filter silently dropped
        from the real WHERE clause shows up here as an assertion failure rather than passing.
        """
        sql = self._sql
        rest = list(params[1:])
        district = params[0]
        rows = [c for c in self.store["cases"] if c["district"] == district]

        if "c.status = %s" in sql:
            value = rest.pop(0)
            rows = [c for c in rows if c["status"] == value]
        if "c.submitted_at >= %s" in sql:
            value = rest.pop(0)
            rows = [c for c in rows if c["submitted_at"].date() >= value]
        if "c.submitted_at <= %s" in sql:
            value = rest.pop(0)
            rows = [c for c in rows if c["submitted_at"].date() <= value]
        if "c.damage_category = %s" in sql:
            value = rest.pop(0)
            rows = [c for c in rows if c["damage_category"] == value]
        if "c.ds_division_id = %s" in sql:
            value = rest.pop(0)
            rows = [c for c in rows if c["ds_division_id"] == value]
        return rows, rest

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        self._sql = sql
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif sql.startswith("SELECT COUNT(*) FROM cases c"):
            rows, _rest = self._matching(params)
            self._result = (len(rows),)
        elif "SELECT c.canonical_id, c.submitted_at, c.damage_category" in sql:
            rows, rest = self._matching(params)
            limit = rest.pop(0)  # EXPORT_MAX_ROWS
            rows = sorted(
                rows, key=lambda c: (c["submitted_at"], c["id"]), reverse=True
            )[:limit]
            out = []
            for c in rows:
                il = self._latest_inference(c["id"])
                out.append(
                    (
                        c["canonical_id"],
                        c["submitted_at"],
                        c["damage_category"],
                        il["confidence"] if il else None,
                        il["was_overridden"] if il else None,
                        c["status"],
                        c["approved_amount"],
                        c["district"],
                        c["ds_division_id"],
                    )
                )
            self._rows = out
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.store["audit"].append(
                {
                    "id": len(self.store["audit"]) + 1,
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
                    "created_at": created_at,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchall(self):
        return self._rows

    def fetchmany(self, size):
        batch, self._rows = self._rows[:size], self._rows[size:]
        return batch

    def fetchone(self):
        return self._result


class FakeConn:
    def __init__(self, store):
        self.store = store
        self.commits = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self, name=None):
        return FakeCursor(self.store, name=name)

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


@pytest.fixture
def store():
    return {
        "cases": [
            _case(1, DISTRICT_A, submitted_at=datetime(2026, 7, 5, 9, 0)),
            _case(
                2, DISTRICT_A, status="Approved", approved_amount=45000.0,
                submitted_at=datetime(2026, 7, 6, 9, 0), ds_division_id=DIVISION_A,
            ),
            _case(
                3, DISTRICT_A, status="Payment Processed", approved_amount=30000.5,
                submitted_at=datetime(2026, 6, 20, 9, 0), damage_category="crop",
            ),
            _case(4, DISTRICT_B, submitted_at=datetime(2026, 7, 6, 9, 0)),  # other district
        ],
        "inference_log": [],
        "audit": [],
    }


@pytest.fixture
def conn(store):
    return FakeConn(store)


@pytest.fixture
def client(monkeypatch, conn):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.admin._get_connection", lambda: conn)
    return app.test_client()


def _csv_rows(res):
    """Decodes a streamed CSV response into (header, rows), stripping the UTF-8 BOM."""
    text = res.get_data(as_text=True).lstrip("﻿")
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader if r]
    return all_rows[0], all_rows[1:]


# --- auth + district scoping --------------------------------------------------------------


def test_missing_token_401(client):
    assert client.get("/api/v1/admin/export").status_code == 401


def test_non_admin_403(client):
    res = client.get("/api/v1/admin/export", headers=_auth(role="officer"))
    assert res.status_code == 403


def test_no_district_assigned_403(client, store):
    res = client.get("/api/v1/admin/export", headers=_auth(district_id=""))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"
    assert store["audit"] == []


def test_district_id_query_param_cannot_widen_scope(client):
    """A crafted ?district= must be ignored -- scope comes from the verified JWT only (AC4)."""
    res = client.get(
        f"/api/v1/admin/export?district={DISTRICT_B}", headers=_auth()
    )
    _header, rows = _csv_rows(res)
    assert {r[7] for r in rows} == {DISTRICT_A}


def test_other_district_never_appears(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert len(rows) == 3
    assert DISTRICT_B not in {r[7] for r in rows}


# --- input validation ---------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["xlsx", "html", "CSV; DROP"])
def test_invalid_format_400(client, fmt, store):
    res = client.get(f"/api/v1/admin/export?format={fmt}", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_format"
    # Rejected before any DB work -- nothing audited for a request that never ran.
    assert store["audit"] == []


def test_format_is_case_insensitive(client):
    res = client.get("/api/v1/admin/export?format=CSV", headers=_auth())
    assert res.status_code == 200


def test_empty_format_defaults_to_csv(client):
    """`?format=` (present but empty) is treated as "not supplied", matching how
    _build_conditions already treats every empty filter param."""
    res = client.get("/api/v1/admin/export?format=", headers=_auth())
    assert res.status_code == 200
    assert "text/csv" in res.headers["Content-Type"]


def test_invalid_date_400(client, store):
    res = client.get("/api/v1/admin/export?from=not-a-date", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"
    assert store["audit"] == []


# --- CSV contents (AC1) -------------------------------------------------------------------


def test_csv_header_matches_column_contract(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    header, _rows = _csv_rows(res)
    assert header == CSV_COLUMNS


def test_csv_carries_no_pii_columns(client):
    """AC4/NFR-3.3 -- asserted against the real header, not by inspection.

    Matched per column name against a token split, NOT as a naive substring of the joined
    header: "nic" is a substring of "canonical_id", which made the first version of this test
    fail on a perfectly clean header.
    """
    res = client.get("/api/v1/admin/export", headers=_auth())
    header, _rows = _csv_rows(res)
    tokens = {token for column in header for token in column.lower().split("_")}
    for field in PII_FIELDS:
        assert field not in tokens
        assert field not in header


def test_csv_is_not_paginated(client, store):
    """AC1: every matching case, not one page of them. The list endpoint's default page is 20;
    45 cases must all appear."""
    store["cases"] = [
        _case(i, DISTRICT_A, submitted_at=datetime(2026, 7, 1, 9, 0)) for i in range(1, 46)
    ]
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert len(rows) == 45


def test_csv_respects_export_max_rows(client, store, monkeypatch):
    monkeypatch.setattr("app.api.v1.admin.EXPORT_MAX_ROWS", 2)
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert len(rows) == 2


def test_csv_applies_status_filter(client):
    res = client.get("/api/v1/admin/export?status=Approved", headers=_auth())
    _header, rows = _csv_rows(res)
    assert [r[5] for r in rows] == ["Approved"]


def test_csv_applies_damage_type_filter(client):
    res = client.get("/api/v1/admin/export?type=crop", headers=_auth())
    _header, rows = _csv_rows(res)
    assert [r[2] for r in rows] == ["crop"]


def test_csv_applies_date_range_filter(client):
    res = client.get(
        "/api/v1/admin/export?from=2026-07-01&to=2026-07-31", headers=_auth()
    )
    _header, rows = _csv_rows(res)
    assert len(rows) == 2  # the 2026-06-20 case is outside the range


def test_csv_applies_division_filter(client):
    res = client.get(f"/api/v1/admin/export?division={DIVISION_A}", headers=_auth())
    _header, rows = _csv_rows(res)
    assert [r[8] for r in rows] == [DIVISION_A]


def test_sinhala_district_survives_round_trip(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert all(r[7] == DISTRICT_A for r in rows)


def test_csv_starts_with_utf8_bom(client):
    """Without a BOM, Excel on Windows decodes the file as the legacy ANSI codepage and every
    Sinhala district name becomes mojibake."""
    res = client.get("/api/v1/admin/export", headers=_auth())
    assert res.get_data().startswith(b"\xef\xbb\xbf")


# --- inference_log fan-out (append-only table) --------------------------------------------


def test_case_with_multiple_inference_rows_appears_exactly_once(client, store):
    """CRITICAL: inference_log is append-only -- an officer override inserts a SECOND row for
    the same case. A plain LEFT JOIN would duplicate the case; the LATERAL latest-row join
    must not."""
    store["inference_log"] = [
        _inference(2, confidence=0.55, was_overridden=False, created_at=datetime(2026, 7, 8, 10, 0)),
        _inference(2, confidence=0.91, was_overridden=True, created_at=datetime(2026, 7, 9, 10, 0)),
    ]
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    matching = [r for r in rows if r[0] == "HEC-2026-0002"]
    assert len(matching) == 1
    # …and carries the NEWEST row's values, not the first-inserted ones.
    assert matching[0][3] == "91.0%"
    assert matching[0][4] == "true"


def test_case_without_inference_row_has_blank_ai_columns(client):
    """Most cases have no inference_log row at all (only the officer classify path writes one).
    That must read as blank, never as a fabricated `false` finding."""
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert all(r[3] == "" and r[4] == "" for r in rows)


def test_unapproved_case_has_blank_amount(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    submitted = next(r for r in rows if r[5] == "Submitted")
    assert submitted[6] == ""


def test_approved_amount_is_formatted(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    approved = next(r for r in rows if r[0] == "HEC-2026-0002")
    assert approved[6] == "45,000.00"


def test_timestamps_are_offset_free_utc(client, store):
    """cases.submitted_at is TIMESTAMPTZ, so a naive isoformat() emits '+00:00' -- which Excel
    imports as TEXT, breaking date sorting/filtering in the very workflow this export serves.
    Values must be normalised to UTC and rendered without an offset."""
    store["cases"] = [
        _case(
            1,
            DISTRICT_A,
            # 14:30 at UTC+05:30 (Sri Lanka) is 09:00 UTC.
            submitted_at=datetime(
                2026, 7, 5, 14, 30, tzinfo=timezone(timedelta(hours=5, minutes=30))
            ),
        )
    ]
    res = client.get("/api/v1/admin/export", headers=_auth())
    _header, rows = _csv_rows(res)
    assert rows[0][1] == "2026-07-05 09:00:00"
    assert "+" not in rows[0][1]


# --- response headers ---------------------------------------------------------------------


def test_csv_response_headers(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    assert res.status_code == 200
    assert "text/csv" in res.headers["Content-Type"]
    assert "charset=utf-8" in res.headers["Content-Type"]
    disposition = res.headers["Content-Disposition"]
    assert disposition.startswith("attachment; filename=hec-cases-")
    assert disposition.endswith(".csv")


def test_csv_filename_carries_today(client):
    res = client.get("/api/v1/admin/export", headers=_auth())
    assert date.today().isoformat() in res.headers["Content-Disposition"]


def test_csv_connection_is_closed_after_streaming(client, conn):
    res = client.get("/api/v1/admin/export", headers=_auth())
    res.get_data()  # drain the generator
    assert conn.closed is True


# --- PDF (AC2) ----------------------------------------------------------------------------


def test_pdf_response_is_a_real_pdf(client):
    res = client.get("/api/v1/admin/export?format=pdf", headers=_auth())
    assert res.status_code == 200
    assert res.headers["Content-Type"].startswith("application/pdf")
    assert res.get_data().startswith(b"%PDF-")


def test_pdf_response_headers(client):
    res = client.get("/api/v1/admin/export?format=pdf", headers=_auth())
    disposition = res.headers["Content-Disposition"]
    assert disposition.startswith("attachment; filename=hec-cases-")
    assert disposition.endswith(".pdf")


def test_pdf_with_zero_cases_still_renders(client, store):
    """Story 7.4's seed data doesn't exist yet -- an empty district is the common path today,
    and must produce a valid (header + empty table + zero summary) report, not a 500."""
    store["cases"] = []
    res = client.get("/api/v1/admin/export?format=pdf", headers=_auth())
    assert res.status_code == 200
    assert res.get_data().startswith(b"%PDF-")


def test_pdf_closes_connection(client, conn):
    client.get("/api/v1/admin/export?format=pdf", headers=_auth())
    assert conn.closed is True


# --- audit (AC5) --------------------------------------------------------------------------


def test_export_writes_audit_row(client, store):
    client.get("/api/v1/admin/export", headers=_auth()).get_data()
    events = [a["event"] for a in store["audit"]]
    assert events == ["admin_exported_cases"]
    metadata = store["audit"][0]["metadata"]
    assert metadata["format"] == "csv"
    assert metadata["row_count"] == 3
    assert metadata["truncated"] is False


def test_audit_records_the_range_and_actor(client, store):
    client.get(
        "/api/v1/admin/export?from=2026-07-01&to=2026-07-31", headers=_auth()
    ).get_data()
    entry = store["audit"][0]
    assert entry["actor_id"] == "admin-1"
    assert entry["metadata"]["from"] == "2026-07-01"
    assert entry["metadata"]["to"] == "2026-07-31"


def test_audit_records_pdf_format(client, store):
    client.get("/api/v1/admin/export?format=pdf", headers=_auth())
    assert store["audit"][0]["metadata"]["format"] == "pdf"


def test_audit_flags_truncation(client, store, monkeypatch):
    monkeypatch.setattr("app.api.v1.admin.EXPORT_MAX_ROWS", 2)
    client.get("/api/v1/admin/export", headers=_auth()).get_data()
    metadata = store["audit"][0]["metadata"]
    assert metadata["row_count"] == 2
    assert metadata["matched_count"] == 3
    assert metadata["truncated"] is True


def test_audit_is_written_before_the_body_streams(client, store):
    """CRITICAL: a stream_with_context generator runs AFTER the view returns, so an audit write
    placed inside it can be skipped entirely when a client disconnects mid-download. This asserts
    the row exists without ever draining the response body."""
    client.get("/api/v1/admin/export", headers=_auth())
    assert [a["event"] for a in store["audit"]] == ["admin_exported_cases"]
