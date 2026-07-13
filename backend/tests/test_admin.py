"""Tests for GET /api/v1/admin/cases + /api/v1/admin/cases/<offline_id> +
/api/v1/admin/audit/verify-chain (Stories 5.3/5.4, admin district-scoped case list + detail).

DB faked (no Postgres): a FakeConn/FakeCursor implements the SELECT statements + audit
INSERT the endpoints issue, so we exercise require_admin auth, district scoping (no
OR-fallback -- district IS NULL cases are excluded from every admin), filters, sort,
pagination, the PII-free payload, the 4 separately-computed KPIs, the audit-on-view, case
detail (AI result / compensation / audit trail, including their empty states), and global
hash-chain verification, all without a real database.
"""
import json
import uuid
from datetime import datetime

import jwt
import pytest
from flask import request

from app import create_app
from app.infrastructure.audit import write_audit_log

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
    gps_lat=None,
    gps_lng=None,
    submitted_via="app",
):
    return {
        # Parsed from the HEC-YYYY-NNNN suffix -- guarantees uniqueness across all fixture
        # cases in this file (len(canonical) does not: every "HEC-2026-NNNN" id is the same
        # length, which silently collided case_id-scoped data across cases once Story 5.4's
        # tests started correlating audit_log/inference_log/compensation_estimates rows by
        # case_id -- caught by test_case_detail_audit_trail_chronological_and_case_scoped).
        "id": int(canonical.rsplit("-", 1)[-1]),
        "canonical_id": canonical,
        # Real UUID string (Story 5.4 detail endpoint validates offline_id with
        # uuid.UUID()) -- deterministic per canonical id so tests stay readable/stable.
        "offline_id": str(uuid.uuid5(uuid.NAMESPACE_DNS, canonical)),
        "district": district,
        "ds_division_id": ds_division_id,
        "damage_category": damage_category,
        "status": status,
        "submitted_at": submitted_at or datetime(2026, 7, 8, 10, 0, 0),
        "updated_at": updated_at or submitted_at or datetime(2026, 7, 8, 10, 0, 0),
        "approved_amount": approved_amount,
        "confidence": confidence,
        "gps_lat": gps_lat,
        "gps_lng": gps_lng,
        "submitted_via": submitted_via,
        # PII columns that must NEVER appear in the LIST response (submitter_identity_hash
        # IS returned by the more-privileged DETAIL endpoint -- see admin.py's module
        # docstring -- citizen_nic_plain never is, from either endpoint):
        "citizen_nic_plain": "200012345678",
        "submitter_identity_hash": "deadbeef",
    }


def _inference_row(
    case_id, model_type="mobilenetv2", model_version="v1", prediction="crop_damage",
    confidence=0.9, was_overridden=False, override_reason=None, override_category=None,
    ai_severity=None, created_at=None,
):
    return {
        "case_id": case_id,
        "model_type": model_type,
        "model_version": model_version,
        "prediction": prediction,
        "confidence": confidence,
        "was_overridden": was_overridden,
        "override_reason": override_reason,
        "override_category": override_category,
        "input_features": {"ai_severity": ai_severity},
        "created_at": created_at or datetime(2026, 7, 8, 10, 5, 0),
    }


def _compensation_row(
    case_id, amount_lkr=45000.0, raw_estimate_lkr=45000.0, capped=False,
    feature_values=None, model_version="rf_compensation_v2", dataset_version="2021",
    created_at=None,
):
    return {
        "case_id": case_id,
        "amount_lkr": amount_lkr,
        "raw_estimate_lkr": raw_estimate_lkr,
        "capped": capped,
        "feature_values_json": feature_values or {"damage_type": "property", "district": "x"},
        "model_version": model_version,
        "dataset_version": dataset_version,
        "created_at": created_at or datetime(2026, 7, 8, 10, 6, 0),
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
        elif "FROM cases WHERE offline_id" in sql:
            # Story 5.4 case-detail lookup: offline_id + district, both must match (a
            # wrong-district match must miss, same as a nonexistent offline_id).
            offline_id, district = params
            matches = [
                c for c in self.store["cases"]
                if c["offline_id"] == offline_id and c["district"] == district
            ]
            if matches:
                c = matches[0]
                self._result = (
                    c["canonical_id"], c["offline_id"], c["damage_category"], c["status"],
                    c.get("gps_lat"), c.get("gps_lng"), c["submitted_at"], c["updated_at"],
                    c.get("submitted_via", "app"), c.get("submitter_identity_hash"),
                    c.get("approved_amount"), c["id"],
                )
            else:
                self._result = None
        elif "FROM inference_log WHERE case_id" in sql:
            (case_id,) = params
            rows = [r for r in self.store["inference_log"] if r["case_id"] == case_id]
            rows.sort(key=lambda r: r["created_at"], reverse=True)
            self._result = (
                (
                    rows[0]["model_type"], rows[0]["model_version"], rows[0]["prediction"],
                    rows[0]["confidence"], rows[0]["was_overridden"], rows[0]["override_reason"],
                    rows[0]["override_category"], rows[0]["input_features"], rows[0]["created_at"],
                )
                if rows else None
            )
        elif "FROM compensation_estimates WHERE case_id" in sql:
            (case_id,) = params
            rows = [r for r in self.store["compensation_estimates"] if r["case_id"] == case_id]
            self._result = (
                (
                    rows[0]["amount_lkr"], rows[0]["raw_estimate_lkr"], rows[0]["capped"],
                    rows[0]["feature_values_json"], rows[0]["model_version"],
                    rows[0]["dataset_version"], rows[0]["created_at"],
                )
                if rows else None
            )
        elif "FROM audit_log WHERE case_id" in sql:
            # Per-case audit trail (Story 5.4 Task 1) -- chronological, capped.
            case_id, limit = params
            rows = sorted(
                (a for a in self.store["audit"] if a["case_id"] == case_id),
                key=lambda a: a["id"],
            )[:limit]
            self._rows = [
                (a["id"], a["event"], a["actor_id"], a["metadata"], a["created_at"], a["hash"], a["prev_hash"])
                for a in rows
            ]
        elif "FROM audit_log ORDER BY id ASC" in sql:
            # Global chain scan (Story 5.4 Task 2 -- infrastructure/audit.py::verify_chain,
            # unmodified, called for real against this fake).
            rows = sorted(self.store["audit"], key=lambda a: a["id"])
            self._rows = [
                (a["id"], a["case_id"], a["event"], a["actor_id"], a["metadata"], a["created_at"], a["hash"], a["prev_hash"])
                for a in rows
            ]
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
        "inference_log": [],
        "compensation_estimates": [],
    }


def _seed_audit(store, case_id, event, actor_id="admin-1", metadata=None):
    """Writes a real, correctly-hash-chained audit_log row via the actual
    write_audit_log() (not a hand-built fixture dict) so hash-chain-verification tests
    exercise the real hashing logic, not a fake stand-in for it."""
    cur = FakeCursor(store)
    write_audit_log(cur, case_id, event, actor_id, metadata)


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


# --- case detail (Story 5.4) --------------------------------------------------------------

_CASE_1_OFFLINE_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0001"))
_CASE_1_ID = 1


def test_case_detail_happy_path_shape(client):
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    assert set(body.keys()) == {"case", "ai_result", "compensation", "audit_trail"}
    assert body["case"]["canonical_id"] == "HEC-2026-0001"
    assert body["case"]["offline_id"] == _CASE_1_OFFLINE_ID
    assert body["case"]["submitted_via"] == "app"


def test_case_detail_never_returns_citizen_nic_plain(client):
    # CRITICAL #2: migration 009 -- citizen_nic_plain must never be returned by any read
    # endpoint, including this more-privileged detail view.
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    body = res.get_json()
    assert "citizen_nic_plain" not in body["case"]
    assert set(body["case"].keys()) == {
        "canonical_id", "offline_id", "damage_category", "status", "gps_lat", "gps_lng",
        "submitted_at", "updated_at", "submitted_via", "submitter_identity_hash",
        "approved_amount",
    }


def test_case_detail_wrong_district_returns_404_not_403(client):
    # Same district as the requesting admin's own district is DISTRICT_A; this case is
    # DISTRICT_B -- must 404, not leak a 403 that would confirm the case exists elsewhere.
    other_district_offline_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0004"))
    res = client.get(f"/api/v1/admin/cases/{other_district_offline_id}", headers=_auth(district_id=DISTRICT_A))
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_case_detail_nonexistent_offline_id_returns_404(client):
    res = client.get(f"/api/v1/admin/cases/{uuid.uuid4()}", headers=_auth())
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_case_detail_malformed_offline_id_returns_400(client):
    res = client.get("/api/v1/admin/cases/not-a-uuid", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_offline_id"


def test_case_detail_no_district_assigned_returns_403(client):
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth(district_id=""))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"


def test_case_detail_ai_result_null_when_no_inference_log_row(client):
    # Known Data Coverage: inference_log is effectively empty in production today.
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    assert res.get_json()["ai_result"] is None


def test_case_detail_ai_result_populated_with_override(client, store):
    store["inference_log"].append(
        _inference_row(
            _CASE_1_ID, prediction="crop_damage", was_overridden=True,
            override_reason="Clearly property damage, not crop", override_category="property_damage",
            ai_severity="Moderate",
        )
    )
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    ai = res.get_json()["ai_result"]
    assert ai["prediction"] == "crop_damage"  # original AI class, never mutated
    assert ai["was_overridden"] is True
    assert ai["override_category"] == "property_damage"
    assert ai["override_reason"] == "Clearly property damage, not crop"
    assert ai["ai_severity"] == "Moderate"


def test_case_detail_ai_result_uses_latest_row_only(client, store):
    # Two inference_log rows exist for the same case (re-classification) -- only the
    # latest (by created_at) is returned, not both/not the earliest.
    store["inference_log"].append(
        _inference_row(_CASE_1_ID, prediction="no_damage", created_at=datetime(2026, 7, 8, 9, 0, 0))
    )
    store["inference_log"].append(
        _inference_row(_CASE_1_ID, prediction="crop_damage", created_at=datetime(2026, 7, 8, 11, 0, 0))
    )
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    assert res.get_json()["ai_result"]["prediction"] == "crop_damage"


def test_case_detail_compensation_null_when_no_estimate_row(client):
    # Known Data Coverage: compensation_estimates is absent for damage_category="none" or
    # a silently rolled-back estimation failure.
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    assert res.get_json()["compensation"] is None


def test_case_detail_compensation_populated_with_cap(client, store):
    store["compensation_estimates"].append(
        _compensation_row(
            _CASE_1_ID, amount_lkr=100000.0, raw_estimate_lkr=150000.0, capped=True,
            feature_values={"damage_type": "property", "district": DISTRICT_A, "year": 2026},
        )
    )
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    comp = res.get_json()["compensation"]
    assert comp["amount_lkr"] == 100000.0
    assert comp["raw_estimate_lkr"] == 150000.0
    assert comp["capped"] is True
    assert comp["feature_values"]["district"] == DISTRICT_A


def test_case_detail_audit_trail_chronological_and_case_scoped(client, store):
    other_offline_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0002"))
    other_case_id = 2
    _seed_audit(store, _CASE_1_ID, "submitted", "citizen-app")
    _seed_audit(store, other_case_id, "case_synced", "officer-1")  # different case
    _seed_audit(store, _CASE_1_ID, "admin_viewed_case_detail", "admin-1")

    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    trail = res.get_json()["audit_trail"]
    events = [e["event"] for e in trail]
    assert events == ["submitted", "admin_viewed_case_detail"]  # case-scoped, chronological
    assert all("hash" in e and "prev_hash" in e for e in trail)
    del other_offline_id  # unused, kept for readability of the "different case" setup above


def test_case_detail_is_audited(client, store):
    client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    view_events = [a for a in store["audit"] if a["event"] == "admin_viewed_case_detail"]
    assert len(view_events) == 1
    assert view_events[0]["case_id"] == _CASE_1_ID
    assert view_events[0]["actor_id"] == "admin-1"


def test_case_detail_view_event_not_in_its_own_rendered_trail(client, store):
    # Task 1: the view-audit write happens AFTER reading the trail, so this page load's
    # own view event doesn't appear in the trail it just rendered.
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    events = [e["event"] for e in res.get_json()["audit_trail"]]
    assert "admin_viewed_case_detail" not in events


# --- audit chain verification (Story 5.4 AC4) -----------------------------------------------


def test_verify_chain_valid_on_untampered_data(client, store):
    _seed_audit(store, _CASE_1_ID, "submitted", "citizen-app")
    _seed_audit(store, _CASE_1_ID, "case_synced", "officer-1")
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    assert res.status_code == 200
    assert res.get_json() == {"valid": True, "broken_id": None}


def test_verify_chain_detects_tampering(client, store):
    _seed_audit(store, _CASE_1_ID, "submitted", "citizen-app")
    _seed_audit(store, _CASE_1_ID, "case_synced", "officer-1")
    store["audit"][0]["event"] = "tampered_event"  # mutate content without recomputing hash
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    body = res.get_json()
    assert body["valid"] is False
    assert body["broken_id"] == store["audit"][0]["id"]


def test_verify_chain_valid_on_empty_audit_log(client):
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    assert res.get_json() == {"valid": True, "broken_id": None}


def test_verify_chain_response_never_includes_case_id(client, store):
    # Task 2: broken_id is an opaque audit_log.id -- must never join back to case_id in
    # the response (would leak cross-district case existence via the verify action).
    _seed_audit(store, _CASE_1_ID, "submitted", "citizen-app")
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    assert "case_id" not in res.get_json()
