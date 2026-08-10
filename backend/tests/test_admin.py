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
from typing import Any
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

# Story 5.6: a handful of real seeded (language, status) -> template pairs, enough to exercise
# notify_status_change()'s {ref}/{amount} placeholder substitution without needing all 15 rows.
_SMS_TEMPLATES = {
    ("si", "Approved"): "අනුමතයි {ref} රු. {amount}",
    ("si", "Rejected"): "ප්‍රතික්ෂේපයි {ref}",
    ("si", "Under Review"): "සමාලෝචනය {ref}",
    ("si", "Payment Processed"): "ගෙවීම {ref}",
}


def _token(sub="admin-1", role="admin", district_id=DISTRICT_A):
    claims = {"sub": sub, "app_metadata": {"role": role, "district_id": district_id}}
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
    citizen_mobile_plain=None,
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
        # Story 5.6: NULL for every case except ones from the extended SMS-fallback grammar --
        # never returned by any read endpoint (write-only, same convention as citizen_nic_plain).
        "citizen_mobile_plain": citizen_mobile_plain,
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

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
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
                if c["status"] in ("Approved", "Payment Processed")
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
        elif "FROM cases WHERE offline_id" in sql and "FOR UPDATE" in sql:
            # Story 5.6: post_case_action's own copy of the cases SELECT (FOR UPDATE-locked,
            # distinct query text from _load_case_detail's below since Story 5.5's code review
            # fix) gained a 12th column, citizen_mobile_plain, so notify_status_change() never
            # needs a second query.
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
                    c.get("submitted_via", "app"), c.get("approved_amount"), c["id"],
                    c.get("citizen_mobile_plain"),
                )
            else:
                self._result = None
        elif "FROM cases WHERE offline_id" in sql:
            # Story 5.4 case-detail lookup: offline_id + district, both must match (a
            # wrong-district match must miss, same as a nonexistent offline_id). No
            # submitter_identity_hash (code review fix -- dropped from the real SELECT).
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
                    c.get("submitted_via", "app"), c.get("approved_amount"), c["id"],
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
            # Per-case audit trail (Story 5.4 Task 1). Code review fix: the real query is
            # `ORDER BY id DESC LIMIT %s` (newest N, in descending order) -- the endpoint
            # itself reverses to ascending in Python -- NOT `ASC LIMIT %s` (which would keep
            # the oldest N forever once a case exceeds the cap).
            case_id, limit = params
            rows = sorted(
                (a for a in self.store["audit"] if a["case_id"] == case_id),
                key=lambda a: a["id"],
                reverse=True,
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
        elif "UPDATE cases SET status = 'Approved'" in sql:
            # Story 5.5 approve action: status + approved_amount + updated_at together.
            # RETURNING updated_at: the endpoint fetches this back to build its response
            # without a second SELECT, so the fake must hand it back the same way.
            amount, case_id = params
            for c in self.store["cases"]:
                if c["id"] == case_id:
                    c["status"] = "Approved"
                    c["approved_amount"] = amount
                    c["updated_at"] = datetime(2026, 7, 13, 12, 0, 0)  # fixed "now" for tests
                    self._result = (c["updated_at"],)
                    break
        elif "UPDATE cases SET status = %s, updated_at = now()" in sql:
            # Story 5.5 reject/request_info/escalate/mark_paid: status + updated_at.
            new_status, case_id = params
            for c in self.store["cases"]:
                if c["id"] == case_id:
                    c["status"] = new_status
                    c["updated_at"] = datetime(2026, 7, 13, 12, 0, 0)
                    self._result = (c["updated_at"],)
                    break
        elif "INSERT INTO payment_authorizations" in sql:
            case_id, amount, authorized_by = params
            self.store["payment_authorizations"].append(
                {"case_id": case_id, "amount_lkr": amount, "authorized_by": authorized_by}
            )
        elif "SELECT template FROM sms_templates" in sql:
            # Story 5.6: notify_status_change() always queries language='si' today (CRITICAL
            # #6 -- no per-case locale exists). A handful of real seeded templates, enough to
            # exercise {ref}/{amount} placeholder substitution.
            language, status = params
            self._result = (_SMS_TEMPLATES.get((language, status)),) if (language, status) in _SMS_TEMPLATES else None
        elif "FROM compensation_caps" in sql:
            (damage_type,) = params
            rows = sorted(
                (c for c in self.store["compensation_caps"] if c["damage_type"] == damage_type),
                key=lambda c: c["district"],
            )
            self._rows = [
                (c["district"], c["damage_type"], c["cap_amount_lkr"], c["updated_by"], c["updated_at"])
                for c in rows
            ]
        elif "INSERT INTO compensation_caps" in sql:
            district, damage_type, cap_amount_lkr, updated_by = params
            updated_at = datetime(2026, 7, 14, 9, 0, 0)
            existing = next(
                (c for c in self.store["compensation_caps"]
                 if c["district"] == district and c["damage_type"] == damage_type),
                None,
            )
            if existing:
                existing["cap_amount_lkr"] = cap_amount_lkr
                existing["updated_by"] = updated_by
                existing["updated_at"] = updated_at
                row = existing
            else:
                row = {
                    "district": district, "damage_type": damage_type,
                    "cap_amount_lkr": cap_amount_lkr, "updated_by": updated_by,
                    "updated_at": updated_at,
                }
                self.store["compensation_caps"].append(row)
            self._result = (
                row["district"], row["damage_type"], row["cap_amount_lkr"],
                row["updated_by"], row["updated_at"],
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
        "inference_log": [],
        "compensation_estimates": [],
        "payment_authorizations": [],
        "compensation_caps": [],
    }


def _seed_audit(store, case_id, event, actor_id="admin-1", metadata=None):
    """Writes a real, correctly-hash-chained audit_log row via the actual
    write_audit_log() (not a hand-built fixture dict) so hash-chain-verification tests
    exercise the real hashing logic, not a fake stand-in for it."""
    cur = FakeCursor(store)
    write_audit_log(cur, case_id, event, actor_id, metadata)


@pytest.fixture
def sent(monkeypatch):
    """Captures every notify_status_change() -> send_sms() call. Story 5.6: monkeypatched at
    notification_service's own import site (not twilio_client's), same level of fidelity as
    test_notification_service.py -- the real notify_status_change()/write_audit_log() run for
    real, only the actual Twilio call is faked out. Returns True (send succeeded) by default."""
    calls = []
    monkeypatch.setattr(
        "app.infrastructure.sms.notification_service.send_sms",
        lambda to, body: calls.append({"to": to, "body": body}) or True,
    )
    return calls


@pytest.fixture
def client(monkeypatch, store, sent):
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


def test_total_approved_lkr_still_counts_a_case_once_it_is_paid(client, store):
    # Code review fix regression guard: Story 5.5's mark_paid moves a case from 'Approved' to
    # 'Payment Processed' -- the KPI must not drop the case's approved_amount just because it
    # was subsequently paid out.
    case_3 = next(c for c in store["cases"] if c["id"] == 3)
    case_3["status"] = "Payment Processed"
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
    # endpoint, including this more-privileged detail view. Code review fix: nor does
    # submitter_identity_hash appear here anymore -- unused by the frontend, not required by
    # any AC, dropped as an unnecessary exposure surface.
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    body = res.get_json()
    assert "citizen_nic_plain" not in body["case"]
    assert "submitter_identity_hash" not in body["case"]
    assert set(body["case"].keys()) == {
        "canonical_id", "offline_id", "damage_category", "status", "gps_lat", "gps_lng",
        "submitted_at", "updated_at", "submitted_via", "approved_amount",
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


# --- code review fixes (Story 5.4) ----------------------------------------------------------


def test_verify_chain_no_district_assigned_returns_403(client):
    # Code review fix: mirror get_case_detail's guard -- an admin JWT with no district_id
    # shouldn't be able to use ANY admin route, even one whose response carries no case data.
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth(district_id=""))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"


def test_verify_chain_action_is_itself_audited(client, store):
    # Code review fix: this security-sensitive action previously wrote no audit event at all.
    client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    verify_events = [a for a in store["audit"] if a["event"] == "admin_verified_chain"]
    assert len(verify_events) == 1
    assert verify_events[0]["actor_id"] == "admin-1"
    assert verify_events[0]["metadata"]["valid"] is True


def test_case_detail_audit_trail_keeps_newest_rows_not_oldest_when_over_cap(client, store):
    # Code review fix: the original `ORDER BY id ASC LIMIT %s` kept the OLDEST rows forever
    # once a case exceeds MAX_AUDIT_TRAIL_ROWS (200) -- permanently hiding newer events. The
    # trail must show the most recent events, in chronological order.
    for i in range(205):
        _seed_audit(store, _CASE_1_ID, f"event_{i}", "admin-1")
    res = client.get(f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}", headers=_auth())
    events = [e["event"] for e in res.get_json()["audit_trail"]]
    assert len(events) == 200
    assert events[0] == "event_5"  # oldest 5 dropped, not the newest 5
    assert events[-1] == "event_204"  # most recent event survives
    assert events == sorted(events, key=lambda e: int(e.split("_")[1]))  # chronological


# --- case review actions (Story 5.5) --------------------------------------------------------

_CASE_2_OFFLINE_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0002"))
_CASE_2_ID = 2
_CASE_3_OFFLINE_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0003"))  # fixture: Approved
_CASE_3_ID = 3
_CASE_4_OFFLINE_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, "HEC-2026-0004"))  # fixture: DISTRICT_B

VALID_REASON = "Adjusted after re-inspecting the photos on file."  # >= 10 chars


def _action(client, offline_id, action, **body):
    return client.post(
        f"/api/v1/admin/cases/{offline_id}/action",
        headers=_auth(),
        json={"action": action, **body},
    )


def test_action_approve_defaults_to_rf_estimate_when_no_amount_given(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve")
    assert res.status_code == 200
    body = res.get_json()
    assert body["case"]["status"] == "Approved"
    assert body["case"]["approved_amount"] == 45000.0
    assert store["payment_authorizations"] == [
        {"case_id": _CASE_1_ID, "amount_lkr": 45000.0, "authorized_by": "admin-1"}
    ]


def test_action_approve_with_matching_amount_no_reason_required(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=45000.0)
    assert res.status_code == 200


def test_action_approve_with_differing_amount_and_no_reason_400(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=60000.0)
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_action_approve_with_short_reason_400(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=60000.0, reason="too short")
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_action_approve_with_differing_amount_and_valid_reason_succeeds(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=60000.0, reason=VALID_REASON)
    assert res.status_code == 200
    assert res.get_json()["case"]["approved_amount"] == 60000.0


def test_action_approve_no_estimate_no_amount_400(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "approve")
    assert res.status_code == 400
    assert res.get_json()["error"] == "amount_required"


def test_action_approve_no_estimate_with_amount_requires_reason(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=30000.0)
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_action_approve_no_estimate_with_amount_and_reason_succeeds(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=30000.0, reason=VALID_REASON)
    assert res.status_code == 200
    assert res.get_json()["case"]["approved_amount"] == 30000.0


def test_action_approve_amount_must_not_be_negative(client, store):
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=45000.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=-100)
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_amount"


def test_action_approve_at_a_zero_rf_estimate_succeeds(client, store):
    # Code review fix regression guard: a genuine 0 LKR RF estimate (no assessed damage) must
    # still be approvable at that amount -- amount_lkr=0 is valid, only negative amounts aren't.
    store["compensation_estimates"].append(_compensation_row(_CASE_1_ID, amount_lkr=0.0))
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=0)
    assert res.status_code == 200
    assert res.get_json()["case"]["approved_amount"] == 0.0


def test_action_reject_no_reason_400(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "reject")
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_action_reject_short_reason_400(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "reject", reason="nope")
    assert res.status_code == 400
    assert res.get_json()["error"] == "reason_required"


def test_action_reject_valid_reason_succeeds(client, store):
    res = _action(client, _CASE_1_OFFLINE_ID, "reject", reason=VALID_REASON)
    assert res.status_code == 200
    assert res.get_json()["case"]["status"] == "Rejected"
    events = [a for a in store["audit"] if a["event"] == "case_rejected"]
    assert len(events) == 1
    assert events[0]["metadata"]["reason"] == VALID_REASON


def test_action_request_info_no_reason_ok(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "request_info")
    assert res.status_code == 200
    assert res.get_json()["case"]["status"] == "Under Review"


def test_action_escalate_no_reason_ok(client, store):
    res = _action(client, _CASE_1_OFFLINE_ID, "escalate")
    assert res.status_code == 200
    assert res.get_json()["case"]["status"] == "Under Review"
    events = [a for a in store["audit"] if a["event"] == "case_escalated"]
    assert len(events) == 1


def test_action_mark_paid_from_approved_succeeds(client, store):
    res = _action(client, _CASE_3_OFFLINE_ID, "mark_paid")
    assert res.status_code == 200
    assert res.get_json()["case"]["status"] == "Payment Processed"


def test_action_mark_paid_records_a_supplied_reason(client, store):
    # Code review fix regression guard: mark_paid previously force-dropped any supplied
    # reason to {}, silently discarding it. It's optional, but if given, it must be recorded.
    res = _action(client, _CASE_3_OFFLINE_ID, "mark_paid", reason="Disbursed via bank transfer.")
    assert res.status_code == 200
    events = [a for a in store["audit"] if a["event"] == "case_paid"]
    assert len(events) == 1
    assert events[0]["metadata"]["reason"] == "Disbursed via bank transfer."


def test_action_mark_paid_from_submitted_returns_invalid_transition(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "mark_paid")
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_transition"


def test_action_on_rejected_case_returns_case_closed(client):
    _action(client, _CASE_1_OFFLINE_ID, "reject", reason=VALID_REASON)
    res = _action(client, _CASE_1_OFFLINE_ID, "approve", amount_lkr=1000)
    assert res.status_code == 400
    assert res.get_json()["error"] == "case_closed"


def test_action_on_payment_processed_case_returns_case_closed(client):
    _action(client, _CASE_3_OFFLINE_ID, "mark_paid")
    res = _action(client, _CASE_3_OFFLINE_ID, "escalate")
    assert res.status_code == 400
    assert res.get_json()["error"] == "case_closed"


def test_action_wrong_district_returns_404(client):
    res = _action(client, _CASE_4_OFFLINE_ID, "escalate")  # DISTRICT_B, admin is DISTRICT_A
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_action_invalid_action_value_returns_400(client):
    res = _action(client, _CASE_1_OFFLINE_ID, "delete_everything")
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_action"


def test_action_no_district_assigned_returns_403(client):
    res = client.post(
        f"/api/v1/admin/cases/{_CASE_1_OFFLINE_ID}/action",
        headers=_auth(district_id=""),
        json={"action": "escalate"},
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"


def test_action_malformed_offline_id_returns_400(client):
    res = client.post(
        "/api/v1/admin/cases/not-a-uuid/action", headers=_auth(), json={"action": "escalate"},
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_offline_id"


def test_action_bumps_updated_at(client, store):
    # CRITICAL #2: Story 5.3's avg_processing_days KPI depends on updated_at reflecting the
    # last real state change.
    before = store["cases"][0]["updated_at"]
    _action(client, _CASE_1_OFFLINE_ID, "escalate")
    after = next(c for c in store["cases"] if c["id"] == _CASE_1_ID)["updated_at"]
    assert after != before


def test_action_response_includes_the_just_written_audit_event(client):
    # Unlike get_case_detail's view-audit (deliberately written AFTER reading the trail), the
    # action endpoint writes its event BEFORE loading the response, so it IS visible here.
    res = _action(client, _CASE_1_OFFLINE_ID, "escalate")
    events = [e["event"] for e in res.get_json()["audit_trail"]]
    assert "case_escalated" in events


def test_verify_chain_still_valid_after_a_sequence_of_actions(client):
    _action(client, _CASE_1_OFFLINE_ID, "escalate")
    _action(client, _CASE_1_OFFLINE_ID, "request_info")
    _action(client, _CASE_2_OFFLINE_ID, "reject", reason=VALID_REASON)
    _action(client, _CASE_3_OFFLINE_ID, "mark_paid")
    res = client.get("/api/v1/admin/audit/verify-chain", headers=_auth())
    assert res.get_json() == {"valid": True, "broken_id": None}


# --- SMS status notifications (Story 5.6) -------------------------------------------------


@pytest.mark.parametrize(
    "offline_id, action, kwargs",
    [
        (_CASE_1_OFFLINE_ID, "escalate", {}),
        (_CASE_1_OFFLINE_ID, "request_info", {}),
        (_CASE_1_OFFLINE_ID, "reject", {"reason": VALID_REASON}),
        # No compensation estimate exists for case 1 by default -- amount_lkr/reason required
        # (see test_action_approve_no_estimate_with_amount_and_reason_succeeds).
        (_CASE_1_OFFLINE_ID, "approve", {"amount_lkr": 30000, "reason": VALID_REASON}),
        (_CASE_3_OFFLINE_ID, "mark_paid", {}),
    ],
)
def test_every_action_logs_sms_skipped_no_mobile_when_no_mobile_on_file(
    client, store, sent, offline_id, action, kwargs
):
    # Every fixture case has citizen_mobile_plain=None (true for essentially every case today
    # -- only the SMS-fallback channel's extended grammar can ever populate it, CRITICAL #1).
    res = _action(client, offline_id, action, **kwargs)
    assert res.status_code == 200
    assert sent == []
    events = [a["event"] for a in store["audit"]]
    assert "sms_skipped_no_mobile" in events


def test_action_with_mobile_on_file_sends_sms_and_logs_sms_sent(client, store, sent):
    case = next(c for c in store["cases"] if c["id"] == _CASE_1_ID)
    case["citizen_mobile_plain"] = "0771234567"
    res = _action(client, _CASE_1_OFFLINE_ID, "reject", reason=VALID_REASON)
    assert res.status_code == 200
    assert len(sent) == 1
    assert sent[0]["to"] == "0771234567"
    events = [a["event"] for a in store["audit"]]
    assert "sms_sent" in events
    assert "sms_skipped_no_mobile" not in events


def test_action_sms_failure_logs_sms_failed_but_does_not_affect_the_action(
    client, store, monkeypatch
):
    monkeypatch.setattr(
        "app.infrastructure.sms.notification_service.send_sms", lambda to, body: False
    )
    case = next(c for c in store["cases"] if c["id"] == _CASE_1_ID)
    case["citizen_mobile_plain"] = "0771234567"
    res = _action(client, _CASE_1_OFFLINE_ID, "escalate")
    assert res.status_code == 200
    assert res.get_json()["case"]["status"] == "Under Review"
    events = [a["event"] for a in store["audit"]]
    assert "sms_failed" in events


# --- compensation caps settings (Story 5.6, FR-4.4) ---------------------------------------


def test_get_compensation_caps_returns_seeded_rows(client, store):
    store["compensation_caps"].append(
        {
            "district": DISTRICT_A, "damage_type": "property", "cap_amount_lkr": 50000.0,
            "updated_by": "admin-1", "updated_at": datetime(2026, 7, 10, 9, 0, 0),
        }
    )
    res = client.get("/api/v1/admin/settings/compensation-caps", headers=_auth())
    assert res.status_code == 200
    caps = res.get_json()["caps"]
    assert caps == [
        {
            "district": DISTRICT_A, "damage_type": "property", "cap_amount_lkr": 50000.0,
            "updated_by": "admin-1", "updated_at": "2026-07-10T09:00:00",
        }
    ]
    # Code review (Story 5.6): audit-on-view, same convention as list_cases/get_case_detail/
    # get_verify_chain -- every other admin read endpoint logs its own view event.
    events = [a["event"] for a in store["audit"]]
    assert "admin_viewed_compensation_caps" in events


@pytest.mark.parametrize("bad_amount", [float("nan"), float("inf"), float("-inf")])
def test_put_compensation_cap_nan_or_infinity_400(client, bad_amount):
    # Code review (Story 5.6): Python's json module accepts NaN/Infinity as valid floats by
    # default, and both would otherwise pass the `< 0` check (never true for NaN or +Infinity).
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": DISTRICT_A, "cap_amount_lkr": bad_amount},
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_amount"


def test_get_compensation_caps_empty_when_none_configured(client):
    res = client.get("/api/v1/admin/settings/compensation-caps", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["caps"] == []


def test_put_compensation_cap_upserts_and_returns_the_row(client, store):
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(),
        json={"district": DISTRICT_A, "cap_amount_lkr": 60000},
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["district"] == DISTRICT_A
    assert body["damage_type"] == "property"
    assert body["cap_amount_lkr"] == 60000
    assert body["updated_by"] == "admin-1"
    assert len(store["compensation_caps"]) == 1

    events = [a for a in store["audit"] if a["event"] == "compensation_cap_updated"]
    assert len(events) == 1
    assert events[0]["metadata"] == {"district": DISTRICT_A, "cap_amount_lkr": 60000}


def test_put_compensation_cap_updates_existing_row_not_a_duplicate(client, store):
    client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": DISTRICT_A, "cap_amount_lkr": 60000},
    )
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": DISTRICT_A, "cap_amount_lkr": 75000},
    )
    assert res.status_code == 200
    assert res.get_json()["cap_amount_lkr"] == 75000
    assert len(store["compensation_caps"]) == 1


def test_put_compensation_cap_zero_amount_is_valid(client):
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": DISTRICT_A, "cap_amount_lkr": 0},
    )
    assert res.status_code == 200
    assert res.get_json()["cap_amount_lkr"] == 0


def test_put_compensation_cap_negative_amount_400(client):
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": DISTRICT_A, "cap_amount_lkr": -100},
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_amount"


def test_put_compensation_cap_invalid_district_400(client):
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(), json={"district": "Narnia", "cap_amount_lkr": 50000},
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_district"


def test_put_compensation_cap_no_district_assigned_403(client):
    res = client.put(
        "/api/v1/admin/settings/compensation-caps",
        headers=_auth(district_id=""), json={"district": DISTRICT_A, "cap_amount_lkr": 50000},
    )
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"
