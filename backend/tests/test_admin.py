"""Tests for GET /api/v1/admin/cases (Story 5.3, admin district-scoped case list).

DB faked (no Postgres): a FakeConn/FakeCursor implements the 6 distinct SELECT statements
+ the audit INSERT the endpoint issues, so we exercise require_admin auth, district
scoping (no OR-fallback -- district IS NULL cases are excluded from every admin), filters,
sort, pagination, the PII-free payload, the 4 separately-computed KPIs, and the audit-on-
view, all without a real database.
"""
import json
from datetime import datetime

import jwt
import pytest
from flask import request

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256

DISTRICT_A = "අනුරාධපුරය"
DISTRICT_B = "කොළඹ"


def _token(sub="admin-1", role="admin", district_id=DISTRICT_A):
    claims = {"sub": sub, "user_metadata": {"role": role, "district_id": district_id}}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _case(
    canonical,
    district,
    status="Submitted",
    damage_category="crop",
    submitted_at=None,
    updated_at=None,
    approved_amount=None,
    ds_division_id=None,
    confidence=None,
):
    return {
        "id": len(canonical),  # unique enough for these tests
        "canonical_id": canonical,
        "offline_id": f"uuid-{canonical}",
        "district": district,
        "ds_division_id": ds_division_id,
        "damage_category": damage_category,
        "status": status,
        "submitted_at": submitted_at or datetime(2026, 7, 8, 10, 0, 0),
        "updated_at": updated_at or submitted_at or datetime(2026, 7, 8, 10, 0, 0),
        "approved_amount": approved_amount,
        "confidence": confidence,
        # PII columns that must NEVER appear in the response:
        "citizen_nic_plain": "200012345678",
        "submitter_identity_hash": "deadbeef",
    }


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._rows = []
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _district_cases(self, district):
        return [c for c in self.store["cases"] if c["district"] == district]

    def execute(self, sql, params=()):
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        elif "SELECT COUNT(*) FROM cases c WHERE" in sql:
            rows = self._filtered(params)
            self._result = (len(rows),)
        elif "SELECT c.canonical_id" in sql:
            *cond_params, limit, offset = params
            rows = self._filtered(cond_params)
            rows.sort(key=lambda c: c["submitted_at"], reverse=True)
            page = rows[offset : offset + limit]
            self._rows = [
                (
                    c["canonical_id"], c["offline_id"], c["damage_category"], c["status"],
                    c["submitted_at"], c["updated_at"], c["confidence"],
                )
                for c in page
            ]
        elif "COUNT(*) FILTER (WHERE submitted_at" in sql:
            (district,) = params
            this_month = [
                c for c in self._district_cases(district)
                if c["submitted_at"] >= datetime(2026, 7, 1)
            ]
            self._result = (len(this_month),)
        elif "SELECT status, COUNT(*) FROM cases WHERE district" in sql:
            (district,) = params
            by_status = {}
            for c in self._district_cases(district):
                by_status[c["status"]] = by_status.get(c["status"], 0) + 1
            self._rows = list(by_status.items())
        elif "COALESCE(SUM(approved_amount)" in sql:
            (district,) = params
            total = sum(
                c["approved_amount"] or 0
                for c in self._district_cases(district)
                if c["status"] == "Approved"
            )
            self._result = (total,)
        elif "AVG(EXTRACT(EPOCH FROM (COALESCE(updated_at" in sql:
            (district,) = params
            non_submitted = [
                c for c in self._district_cases(district) if c["status"] != "Submitted"
            ]
            if non_submitted:
                # COALESCE(updated_at, now()) -- no fixture case leaves updated_at unset
                # (see `_case`'s default), so `or c["submitted_at"]` never actually fires;
                # kept only so a future None-updated_at fixture wouldn't crash the fake.
                avg_seconds = sum(
                    ((c["updated_at"] or c["submitted_at"]) - c["submitted_at"]).total_seconds()
                    for c in non_submitted
                ) / len(non_submitted)
                self._result = (avg_seconds / 86400,)
            else:
                self._result = (None,)
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.store["audit"].append(
                {
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def _filtered(self, params):
        """Mirrors admin.py::_build_conditions's exact param order (status, from, to,
        type, division, each only present if that query arg was given) by reading the
        live request's query string directly, rather than trying to reverse-engineer
        which optional condition a given positional SQL param belongs to."""
        district = params[0]
        rows = self._district_cases(district)
        args = request.args

        status_filter = args.get("status")
        if status_filter:
            rows = [c for c in rows if c["status"] == status_filter]
        from_date = args.get("from")
        if from_date:
            rows = [c for c in rows if c["submitted_at"].isoformat() >= from_date]
        to_date = args.get("to")
        if to_date:
            rows = [c for c in rows if c["submitted_at"].isoformat() <= to_date]
        damage_type = args.get("type")
        if damage_type:
            rows = [c for c in rows if c["damage_category"] == damage_type]
        division = args.get("division")
        if division:
            rows = [c for c in rows if c["ds_division_id"] == division]
        return rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._result


class FakeConn:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.store)

    def close(self):
        pass


@pytest.fixture
def store():
    return {
        "cases": [
            _case("HEC-2026-0001", DISTRICT_A, submitted_at=datetime(2026, 7, 8, 9, 0)),
            _case("HEC-2026-0002", DISTRICT_A, submitted_at=datetime(2026, 7, 8, 11, 0), confidence=0.87),
            _case(
                "HEC-2026-0003", DISTRICT_A, status="Approved", approved_amount=50000.0,
                submitted_at=datetime(2026, 6, 1, 8, 0), updated_at=datetime(2026, 6, 3, 8, 0),
            ),
            _case("HEC-2026-0004", DISTRICT_B, submitted_at=datetime(2026, 7, 8, 12, 0)),  # other district
            _case("HEC-2026-0005", None, submitted_at=datetime(2026, 7, 8, 13, 0)),  # no district at all
        ],
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.admin._get_connection", lambda: FakeConn(store))
    return app.test_client()


# --- district scoping (AC1/AC2, CRITICAL #1/#2) -----------------------------------------


def test_lists_only_own_district_cases(client):
    res = client.get("/api/v1/admin/cases", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    ids = {c["canonical_id"] for c in body["items"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0002", "HEC-2026-0003"}


def test_other_district_case_never_returned(client):
    res = client.get("/api/v1/admin/cases", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert "HEC-2026-0004" not in ids


def test_district_null_case_excluded_from_every_admin_no_inclusive_fallback(client):
    # Unlike officer's OR-fallback, there is no "my own cases" branch for admin -- a case
    # with no district at all must not appear for ANY admin (documented MVP limitation).
    res = client.get("/api/v1/admin/cases", headers=_auth(district_id=DISTRICT_A))
    ids_a = {c["canonical_id"] for c in res.get_json()["items"]}
    res2 = client.get("/api/v1/admin/cases", headers=_auth(district_id=DISTRICT_B))
    ids_b = {c["canonical_id"] for c in res2.get_json()["items"]}
    assert "HEC-2026-0005" not in ids_a
    assert "HEC-2026-0005" not in ids_b


def test_district_param_in_query_string_is_ignored_not_trusted(client):
    # CRITICAL #2: only g.district_id (verified JWT) may ever scope the query.
    res = client.get(f"/api/v1/admin/cases?district={DISTRICT_B}", headers=_auth(district_id=DISTRICT_A))
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0002", "HEC-2026-0003"}  # still district A


# --- payload shape (CRITICAL #3) --------------------------------------------------------


def test_payload_has_no_pii_and_no_nic_column(client):
    res = client.get("/api/v1/admin/cases", headers=_auth())
    for c in res.get_json()["items"]:
        assert "citizen_nic_plain" not in c
        assert "submitter_identity_hash" not in c
        assert "nic_last4" not in c  # the old stub's AC4 column, deliberately dropped
    first = res.get_json()["items"][0]
    assert set(first.keys()) == {
        "canonical_id", "offline_id", "damage_category", "status",
        "submitted_at", "updated_at", "ai_confidence",
    }


def test_ai_confidence_is_null_when_no_inference_log_row(client):
    # The common case today (Story 5.2 finding: inference_log is effectively empty).
    res = client.get("/api/v1/admin/cases", headers=_auth())
    by_id = {c["canonical_id"]: c for c in res.get_json()["items"]}
    assert by_id["HEC-2026-0001"]["ai_confidence"] is None
    assert by_id["HEC-2026-0002"]["ai_confidence"] == pytest.approx(0.87)


# --- sort + pagination (AC1, AC3) -------------------------------------------------------


def test_default_sort_is_submission_date_desc(client):
    res = client.get("/api/v1/admin/cases", headers=_auth())
    order = [c["canonical_id"] for c in res.get_json()["items"]]
    assert order.index("HEC-2026-0002") < order.index("HEC-2026-0001") < order.index("HEC-2026-0003")


def test_pagination_limit_and_page(client):
    res = client.get("/api/v1/admin/cases?limit=2&page=1", headers=_auth())
    body = res.get_json()
    assert len(body["items"]) == 2
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["limit"] == 2


def test_limit_capped_at_50(client):
    res = client.get("/api/v1/admin/cases?limit=999", headers=_auth())
    assert res.get_json()["limit"] == 50


def test_unknown_sort_column_falls_back_to_submitted_at_not_500(client):
    res = client.get("/api/v1/admin/cases?sort=district; DROP TABLE cases;--", headers=_auth())
    assert res.status_code == 200


# --- filters (AC2) -----------------------------------------------------------------------


def test_status_filter(client):
    res = client.get("/api/v1/admin/cases?status=Approved", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert ids == {"HEC-2026-0003"}


def test_unknown_status_filter_yields_empty_not_error(client):
    res = client.get("/api/v1/admin/cases?status=Nonexistent", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["items"] == []


def test_damage_type_filter(client, store):
    store["cases"].append(_case("HEC-2026-0006", DISTRICT_A, damage_category="property"))
    res = client.get("/api/v1/admin/cases?type=property", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert ids == {"HEC-2026-0006"}


def test_division_filter(client, store):
    store["cases"].append(_case("HEC-2026-0007", DISTRICT_A, ds_division_id="ඉපලෝගම"))
    res = client.get("/api/v1/admin/cases?division=ඉපලෝගම", headers=_auth())
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert ids == {"HEC-2026-0007"}


def test_filters_do_not_affect_kpis(client):
    # KPIs are always district-wide, independent of the list's own filters (design choice,
    # not the old stub's single combined query).
    res = client.get("/api/v1/admin/cases?status=Approved", headers=_auth())
    assert res.get_json()["kpis"]["by_status"] == {"Submitted": 2, "Approved": 1}


# --- KPIs (AC5) --------------------------------------------------------------------------


def test_kpis_scoped_to_district_independent_of_list_filters(client):
    res = client.get("/api/v1/admin/cases", headers=_auth())
    kpis = res.get_json()["kpis"]
    assert kpis["by_status"] == {"Submitted": 2, "Approved": 1}
    assert kpis["total_approved_lkr"] == 50000.0


def test_total_approved_sums_approved_amount_not_ai_estimate(client):
    # CRITICAL #5 regression guard.
    res = client.get("/api/v1/admin/cases", headers=_auth())
    assert res.get_json()["kpis"]["total_approved_lkr"] == 50000.0


def test_avg_processing_days_none_when_nothing_has_left_submitted(client, store):
    store["cases"] = [c for c in store["cases"] if c["status"] == "Submitted"]
    res = client.get("/api/v1/admin/cases", headers=_auth())
    assert res.get_json()["kpis"]["avg_processing_days"] is None


# --- audit on view -------------------------------------------------------------------------


def test_view_is_audited(client, store):
    client.get(
        "/api/v1/admin/cases",
        headers={**_auth(), "X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
    )
    assert len(store["audit"]) == 1
    row = store["audit"][0]
    assert row["event"] == "admin_viewed_cases"
    assert row["actor_id"] == "admin-1"
    assert row["metadata"]["ip_address"] == "203.0.113.9"
    assert row["metadata"]["result_count"] == 3


# --- auth --------------------------------------------------------------------------------


def test_missing_token_401(client, store):
    res = client.get("/api/v1/admin/cases")
    assert res.status_code == 401
    assert store["audit"] == []


def test_non_admin_403(client, store):
    res = client.get("/api/v1/admin/cases", headers=_auth(role="officer"))
    assert res.status_code == 403
    assert store["audit"] == []


# --- code review fixes --------------------------------------------------------------------


def test_no_district_assigned_returns_403_not_silent_empty_list(client, store):
    # Code review fix: an admin JWT with no district_id claim previously fell through to a
    # query that always returns zero rows, indistinguishable from "my district genuinely
    # has no cases yet." Must surface a distinguishing error instead.
    res = client.get("/api/v1/admin/cases", headers=_auth(district_id=""))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"
    assert store["audit"] == []


def test_invalid_from_date_returns_400_not_500(client):
    # Code review fix: a malformed date previously reached Postgres unvalidated.
    res = client.get("/api/v1/admin/cases?from=not-a-date", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"


def test_invalid_to_date_returns_400_not_500(client):
    res = client.get("/api/v1/admin/cases?to=not-a-date", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"


def test_valid_from_to_date_still_filters_correctly(client):
    # Regression guard alongside the two tests above -- validation must reject garbage
    # without rejecting legitimate ISO dates.
    res = client.get("/api/v1/admin/cases?from=2026-07-01&to=2026-07-31", headers=_auth())
    assert res.status_code == 200
    ids = {c["canonical_id"] for c in res.get_json()["items"]}
    assert ids == {"HEC-2026-0001", "HEC-2026-0002"}  # excludes the 2026-06 Approved case


def test_page_beyond_total_returns_empty_not_error(client):
    # Code review fix: an absurdly large `page` must not error even though the offset is
    # now clamped to `total` server-side before the paginated query runs.
    res = client.get("/api/v1/admin/cases?page=999&limit=2", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["items"] == []
    assert res.get_json()["total"] == 3
