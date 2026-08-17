"""Tests for GET /api/v1/admin/analytics (Story 7.1, FR-7.1).

DB faked (no Postgres), same FakeConn/FakeCursor style as test_admin.py, but scoped only to
this endpoint's own queries: volume trend (fixed trailing 12 months anchored to `to`),
status distribution + compensation-by-month (both scoped to the from/to filter), and AI
metrics (confidence histogram, avg processing-time-ms, override-rate this-month-vs-last-month
trend, all from the LATEST inference_log row per case). "This/last month" and "trailing 12
months" are anchored to the resolved `to_date` (default: today), never to real wall-clock
now() -- see admin.py's module comment above get_analytics -- so every test below is
deterministic regardless of when it actually runs, driven entirely by explicit `to=` params.
"""
import json
from typing import Any
from datetime import date, datetime

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256

DISTRICT_A = "අනුරාධපුරය"
DISTRICT_B = "කොළඹ"


def _token(sub="admin-1", role="admin", district_id=DISTRICT_A):
    claims = {"sub": sub, "app_metadata": {"role": role, "district_id": district_id}}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _case(id_, district, status="Submitted", submitted_at=None, updated_at=None, approved_amount=None):
    return {
        "id": id_,
        "district": district,
        "status": status,
        "submitted_at": submitted_at,
        "updated_at": updated_at or submitted_at,
        "approved_amount": approved_amount,
    }


def _inference(case_id, confidence=0.9, was_overridden=False, processing_ms=None, created_at=None,
               id_=None):
    return {
        "case_id": case_id,
        # `id` matters: inference_log is append-only and BIGSERIAL, so a higher id is always the
        # later write even when two rows share a created_at (now() is transaction-stable, so an
        # AI classification and the officer override written in one transaction do share one).
        # Defaults to None; _latest_inference falls back to insertion order, which models the
        # same thing for fixtures that don't care.
        "id": id_,
        "confidence": confidence,
        "was_overridden": was_overridden,
        "input_features": {"ai_processing_time_ms": processing_ms} if processing_ms is not None else {},
        "created_at": created_at or datetime(2026, 7, 8, 10, 0, 0),
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

    def _latest_inference(self, case_id, sql=""):
        """Resolve the "latest" inference row the way the SQL under test actually asks for it.

        This harness READS THE SQL rather than always applying the correct ordering -- the same
        technique test_research_export.py's _joined() uses. If it unconditionally sorted by
        (created_at, id), a regression test for the missing tiebreaker would be asserting a
        property of this file rather than of admin.py, and would pass whether or not the fix
        was present. Verified: removing `, id DESC` from admin.py turns
        test_override_rate_uses_id_tiebreaker_for_same_timestamp_rows red.

        Without the tiebreaker, Postgres may return either row that ties on created_at; insertion
        order is the most plausible model of that, so the unfixed branch takes the FIRST match.
        """
        indexed = [
            (i, r) for i, r in enumerate(self.store["inference_log"]) if r["case_id"] == case_id
        ]
        if not indexed:
            return None
        # Match the ORDER BY clause itself, not a bare "id DESC" -- admin.py's queries carry an
        # explanatory SQL comment containing that phrase, so the looser check matched the COMMENT
        # and the regression test passed even with the tiebreaker removed. Caught by mutation
        # testing on 2026-08-17; it is the exact "test that can only pass" trap this project has
        # hit three times.
        if "created_at DESC, id DESC" in sql:
            return max(indexed, key=lambda t: (t[1]["created_at"], t[1]["id"] or t[0]))[1]
        # Unfixed ordering: created_at alone, ties broken arbitrarily (first row wins).
        newest = max(r["created_at"] for _i, r in indexed)
        return next(r for _i, r in indexed if r["created_at"] == newest)

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        # Every upper bound below is EXCLUSIVE (a `date`, compared with `<`, against the
        # fixture's own `.date()`-truncated timestamp) -- mirrors the real query's fix for
        # the midnight-truncation bug (code review): `submitted_at < to_date_exclusive` is
        # the correct equivalent of "inclusive of every hour of to_date", not `<= to_date`.
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif "date_trunc('month', submitted_at) AS month, COUNT(*)" in sql:
            district, since, until_exclusive = params
            by_month = {}
            for c in self._district_cases(district):
                if c["submitted_at"] and since <= c["submitted_at"].date() < until_exclusive:
                    key = date(c["submitted_at"].year, c["submitted_at"].month, 1)
                    by_month[key] = by_month.get(key, 0) + 1
            self._rows = sorted(by_month.items())
        elif "SELECT status, COUNT(*) FROM cases" in sql:
            district, from_d, until_exclusive = params
            by_status = {}
            for c in self._district_cases(district):
                if c["submitted_at"] and from_d <= c["submitted_at"].date() < until_exclusive:
                    by_status[c["status"]] = by_status.get(c["status"], 0) + 1
            self._rows = list(by_status.items())
        elif "date_trunc('month', updated_at)" in sql:
            district, from_d, until_exclusive = params
            by_month = {}
            for c in self._district_cases(district):
                if c["status"] not in ("Approved", "Payment Processed"):
                    continue
                if c["updated_at"] and from_d <= c["updated_at"].date() < until_exclusive:
                    key = date(c["updated_at"].year, c["updated_at"].month, 1)
                    by_month[key] = by_month.get(key, 0) + (c["approved_amount"] or 0)
            self._rows = sorted(by_month.items())
        elif "SELECT il.confidence, il.input_features" in sql:
            district, from_d, until_exclusive = params
            out = []
            for c in self._district_cases(district):
                if not (c["submitted_at"] and from_d <= c["submitted_at"].date() < until_exclusive):
                    continue
                il = self._latest_inference(c["id"], sql)
                if il:
                    out.append((il["confidence"], il["input_features"]))
            self._rows = out
        elif "SELECT il.was_overridden" in sql:
            district, start, end = params
            out = []
            for c in self._district_cases(district):
                if not (c["submitted_at"] and start <= c["submitted_at"].date() < end):
                    continue
                il = self._latest_inference(c["id"], sql)
                if il:
                    out.append((il["was_overridden"],))
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
            _case(1, DISTRICT_A, status="Submitted", submitted_at=datetime(2026, 7, 5, 9, 0)),
            _case(
                2, DISTRICT_A, status="Approved", approved_amount=45000.0,
                submitted_at=datetime(2026, 7, 6, 9, 0), updated_at=datetime(2026, 7, 10, 9, 0),
            ),
            _case(
                3, DISTRICT_A, status="Payment Processed", approved_amount=30000.0,
                submitted_at=datetime(2026, 6, 20, 9, 0), updated_at=datetime(2026, 6, 25, 9, 0),
            ),
            _case(4, DISTRICT_B, submitted_at=datetime(2026, 7, 6, 9, 0)),  # other district
        ],
        "inference_log": [],
        "audit": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.admin._get_connection", lambda: FakeConn(store))
    return app.test_client()


# --- auth + district scoping --------------------------------------------------------------


def test_missing_token_401(client):
    res = client.get("/api/v1/admin/analytics")
    assert res.status_code == 401


def test_non_admin_403(client):
    res = client.get("/api/v1/admin/analytics", headers=_auth(role="officer"))
    assert res.status_code == 403


def test_no_district_assigned_403(client, store):
    res = client.get("/api/v1/admin/analytics", headers=_auth(district_id=""))
    assert res.status_code == 403
    assert res.get_json()["error"] == "no_district_assigned"
    assert store["audit"] == []


def test_other_district_data_never_appears(client, store):
    # Code review fix: the original assertion only bounded status_distribution's total count
    # (`<= 3`), which would still pass even if district B's data silently leaked into ANY
    # OTHER section -- volume_trend, compensation_by_month, and ai_metrics were never
    # checked. Give district B's case an approval + an inference_log row so a leak into
    # every section is actually detectable, then check all four sections explicitly.
    case_4 = next(c for c in store["cases"] if c["id"] == 4)
    case_4["status"] = "Approved"
    case_4["approved_amount"] = 999999.0
    store["inference_log"].append(_inference(4, confidence=0.42, was_overridden=True))

    res = client.get(
        "/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth(district_id=DISTRICT_A)
    )
    body = res.get_json()

    assert sum(body["status_distribution"].values()) == 3  # cases 1, 2, 3 -- never case 4
    assert sum(m["count"] for m in body["volume_trend"]) == 3
    # Cases 2 (45000.0) + 3 (30000.0) -- both within this range -- never case 4's 999999.0.
    assert sum(m["total_lkr"] for m in body["compensation_by_month"]) == 75000.0
    assert body["ai_metrics"]["sample_count"] == 0  # case 4's inference_log row must not count
    assert body["ai_metrics"]["confidence_histogram"] == [0] * 10


# --- date range validation + defaulting ------------------------------------------------


def test_invalid_from_date_400(client):
    res = client.get("/api/v1/admin/analytics?from=not-a-date", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"


def test_invalid_to_date_400(client):
    res = client.get("/api/v1/admin/analytics?to=not-a-date", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"


def test_from_after_to_returns_400_not_silently_empty(client):
    # Code review fix: an inverted range previously fell through to queries that return
    # empty result sets, silently indistinguishable from "no data in a valid range."
    res = client.get("/api/v1/admin/analytics?from=2026-08-01&to=2026-07-01", headers=_auth())
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_date"


def test_default_range_is_last_30_days_ending_today(client):
    res = client.get("/api/v1/admin/analytics", headers=_auth())
    body = res.get_json()
    assert body["range"]["to"] == date.today().isoformat()


def test_explicit_range_echoed_back(client):
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    body = res.get_json()
    assert body["range"] == {"from": "2026-06-01", "to": "2026-07-15"}


# --- status distribution (AC1, AC3) ------------------------------------------------------


def test_status_distribution_scoped_to_filter_range(client):
    res = client.get("/api/v1/admin/analytics?from=2026-07-01&to=2026-07-15", headers=_auth())
    body = res.get_json()
    # Case 3 (Payment Processed) was submitted 2026-06-20 -- outside this filter.
    assert body["status_distribution"] == {"Submitted": 1, "Approved": 1}


def test_status_distribution_widens_with_a_wider_filter(client):
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    body = res.get_json()
    assert body["status_distribution"] == {"Submitted": 1, "Approved": 1, "Payment Processed": 1}


def test_to_date_is_inclusive_of_the_whole_day_not_just_midnight(client, store):
    # Code review fix (the headline bug): a case submitted late in the day ON `to` was
    # previously excluded, because `submitted_at <= %s` against a bare `date` casts to
    # 00:00:00 of that day in Postgres. A case at 23:00 on the `to` date must still count.
    store["cases"].append(
        _case(7, DISTRICT_A, status="Under Review", submitted_at=datetime(2026, 7, 15, 23, 0))
    )
    res = client.get("/api/v1/admin/analytics?from=2026-07-15&to=2026-07-15", headers=_auth())
    body = res.get_json()
    assert body["status_distribution"] == {"Under Review": 1}


# --- compensation by month (AC1, CRITICAL: approved_amount not compensation_estimates) ----


def test_compensation_by_month_uses_approved_amount_and_updated_at(client):
    res = client.get("/api/v1/admin/analytics?from=2026-07-01&to=2026-07-15", headers=_auth())
    body = res.get_json()
    assert body["compensation_by_month"] == [{"month": "2026-07-01", "total_lkr": 45000.0}]


def test_compensation_by_month_includes_payment_processed(client):
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    body = res.get_json()
    months = {m["month"]: m["total_lkr"] for m in body["compensation_by_month"]}
    assert months["2026-06-01"] == 30000.0
    assert months["2026-07-01"] == 45000.0


def test_compensation_by_month_empty_when_nothing_approved_in_range(client, store):
    store["cases"] = [c for c in store["cases"] if c["status"] == "Submitted"]
    res = client.get("/api/v1/admin/analytics", headers=_auth())
    assert res.get_json()["compensation_by_month"] == []


# --- volume trend (AC1, fixed 12 months anchored to `to`) ---------------------------------


def test_volume_trend_covers_trailing_12_months_from_to_date(client, store):
    # A case submitted 13 months before `to` must be excluded from the trend.
    store["cases"].append(_case(5, DISTRICT_A, submitted_at=datetime(2025, 6, 1, 9, 0)))
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    months = {m["month"] for m in res.get_json()["volume_trend"]}
    assert "2025-06-01" not in months
    assert "2026-07-01" in months


def test_volume_trend_independent_of_the_narrower_from_filter(client):
    # from=2026-07-01 (a 2-week window) must not shrink the trend's own 12-month window --
    # case 3 (submitted 2026-06-20) still shows up in the trend even though it's excluded
    # from status_distribution/compensation_by_month by the narrow filter.
    res = client.get("/api/v1/admin/analytics?from=2026-07-01&to=2026-07-15", headers=_auth())
    months = {m["month"]: m["count"] for m in res.get_json()["volume_trend"]}
    assert months.get("2026-06-01") == 1


def test_volume_trend_has_an_upper_bound_anchored_to_to_date(client, store):
    # Code review fix: the trend previously had NO upper bound at all -- a case submitted
    # after `to` (up to the real present) leaked in even though the trend is documented as
    # "anchored to to_date." A case submitted after `to` must be excluded.
    store["cases"].append(_case(8, DISTRICT_A, submitted_at=datetime(2026, 7, 20, 9, 0)))
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    months = {m["month"]: m["count"] for m in res.get_json()["volume_trend"]}
    # July bucket: cases 1 (07-05) and 2 (07-06), both <= to_date -- NOT case 8 (07-20, after
    # to_date). Without the fix this would be 3 (case 8 leaking into the same month bucket).
    assert months.get("2026-07-01") == 2


# --- AI metrics: confidence histogram + processing time (AC2) -----------------------------


def test_confidence_histogram_buckets_correctly(client, store):
    store["inference_log"] = [
        _inference(1, confidence=0.05),   # bucket 0
        _inference(2, confidence=0.87),   # bucket 8
        _inference(3, confidence=1.0),    # folds into last bucket (9), not an 11th
    ]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    hist = res.get_json()["ai_metrics"]["confidence_histogram"]
    assert len(hist) == 10
    assert hist[0] == 1
    assert hist[8] == 1
    assert hist[9] == 1
    assert sum(hist) == 3


def test_confidence_histogram_empty_when_no_inference_log_rows(client):
    # Known data-coverage reality (Story 7.1 Dev Notes): inference_log is often empty.
    res = client.get("/api/v1/admin/analytics", headers=_auth())
    ai = res.get_json()["ai_metrics"]
    assert ai["confidence_histogram"] == [0] * 10
    assert ai["sample_count"] == 0


def test_ai_metrics_uses_latest_inference_row_only_not_both(client, store):
    # Case 1 was re-classified: two inference_log rows -- only the latest counts.
    store["inference_log"] = [
        _inference(1, confidence=0.2, created_at=datetime(2026, 7, 1, 9, 0)),
        _inference(1, confidence=0.9, created_at=datetime(2026, 7, 2, 9, 0)),
    ]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    ai = res.get_json()["ai_metrics"]
    assert ai["sample_count"] == 1
    assert ai["confidence_histogram"][9] == 1  # only the 0.9 row counted


def test_avg_processing_time_ms_averages_across_sampled_cases(client, store):
    store["inference_log"] = [
        _inference(1, processing_ms=200.0),
        _inference(2, processing_ms=600.0),
    ]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    assert res.get_json()["ai_metrics"]["avg_processing_time_ms"] == 400.0


def test_avg_processing_time_ms_null_when_no_data(client):
    res = client.get("/api/v1/admin/analytics", headers=_auth())
    assert res.get_json()["ai_metrics"]["avg_processing_time_ms"] is None


# --- AI metrics: override-rate trend (AC2, anchored to `to`, independent of from/to filter) --


def test_override_rate_trend_this_vs_last_month(client, store):
    store["inference_log"] = [
        _inference(1, was_overridden=True),   # case 1 submitted 2026-07-05 -> "this month"
        _inference(3, was_overridden=False),  # case 3 submitted 2026-06-20 -> "last month"
    ]
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend == {"this_month_pct": 100.0, "last_month_pct": 0.0, "direction": "up"}


def test_override_rate_uses_id_tiebreaker_for_same_timestamp_rows(client, store):
    """Two inference rows sharing a created_at must resolve to the higher id. Regression for A3.

    This is not a contrived tie. `now()` is transaction-stable in Postgres, so an AI
    classification and the officer override that corrects it -- written in the SAME transaction,
    which is exactly how inference.py's override path works -- carry an identical created_at.
    Ordering on created_at alone then picks arbitrarily between "the AI said crop damage" and
    "the officer corrected it to property damage".

    That matters beyond the UI: this query feeds the override rate, and NFR-6.3's override rate
    is a figure the dissertation reports. Story 7.2 added `ORDER BY created_at DESC, id DESC` to
    its own LATERAL for precisely this reason; list_cases, get_analytics and the case-detail
    query never got it.

    MUTATION-VERIFIED 2026-08-17: removing `, id DESC` from admin.py's override-rate LATERALs
    turns this red. The harness reads the SQL (see _latest_inference) so the assertion is about
    admin.py, not about this file.
    """
    same_instant = datetime(2026, 7, 5, 10, 0, 0)
    store["inference_log"] = [
        # id=1: the AI's original call, NOT overridden. Listed first so insertion order and the
        # correct answer disagree -- without the tiebreaker this row wins and the rate reads 0%.
        _inference(1, was_overridden=False, created_at=same_instant, id_=1),
        # id=2: the officer's override, written in the same transaction. This is the truth.
        _inference(1, was_overridden=True, created_at=same_instant, id_=2),
    ]
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend["this_month_pct"] == 100.0, (
        "the superseded AI row won the tie -- the id tiebreaker is missing from the "
        "override-rate LATERAL, and the reported override rate is wrong"
    )


def test_override_rate_trend_no_data_when_neither_month_has_samples(client):
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend == {"this_month_pct": None, "last_month_pct": None, "direction": "no_data"}


def test_override_rate_trend_up_when_this_month_rate_is_higher(client, store):
    # Renamed from the misleading "..._flat_when_rates_equal" (code review fix): this case
    # is actually asymmetric (100% vs 50%) and was never a flat-rate test despite its old
    # name/comment promising a "true-flat case below" that didn't exist in this file.
    store["cases"].append(_case(6, DISTRICT_A, submitted_at=datetime(2026, 6, 22, 9, 0)))
    store["inference_log"] = [
        _inference(1, was_overridden=True),   # this month
        _inference(3, was_overridden=True),   # last month
        _inference(6, was_overridden=False),  # last month
    ]
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend == {"this_month_pct": 100.0, "last_month_pct": 50.0, "direction": "up"}


def test_override_rate_trend_flat_when_rates_are_equal(client, store):
    # Code review fix: the genuine flat-rate case (`_override_trend`'s flat branch) was
    # never actually exercised by any test until now.
    store["cases"].append(_case(6, DISTRICT_A, submitted_at=datetime(2026, 6, 22, 9, 0)))
    store["inference_log"] = [
        _inference(1, was_overridden=True),   # this month: 1/1 = 100%
        _inference(3, was_overridden=True),   # last month: 1/2 = 100%
        _inference(6, was_overridden=True),   # last month
    ]
    res = client.get("/api/v1/admin/analytics?to=2026-07-15", headers=_auth())
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend == {"this_month_pct": 100.0, "last_month_pct": 100.0, "direction": "flat"}


def test_override_rate_trend_independent_of_from_to_filter(client, store):
    # A narrow from/to filter that excludes case 3 entirely must not affect the trend, which
    # is anchored to `to` regardless of `from`.
    store["inference_log"] = [_inference(3, was_overridden=True)]
    res = client.get(
        "/api/v1/admin/analytics?from=2026-07-10&to=2026-07-15", headers=_auth()
    )
    trend = res.get_json()["ai_metrics"]["override_rate_trend"]
    assert trend["last_month_pct"] == 100.0


# --- empty-district response shape (AC5, Task 2's own "Empty-district case" bullet) -------


def test_zero_case_district_returns_the_full_empty_shape(client, store):
    # Code review fix: every prior "empty" test either narrowed the date filter or emptied
    # inference_log against the same 3-case district fixture -- none actually verified the
    # true zero-case-in-the-district response, where all 4 sections are simultaneously
    # 0/[]/null, as Task 2's own bullet and AC5 call for.
    store["cases"] = [c for c in store["cases"] if c["district"] != DISTRICT_A]
    res = client.get("/api/v1/admin/analytics", headers=_auth(district_id=DISTRICT_A))
    assert res.status_code == 200
    body = res.get_json()
    assert body["volume_trend"] == []
    assert body["status_distribution"] == {}
    assert body["compensation_by_month"] == []
    assert body["ai_metrics"] == {
        "confidence_histogram": [0] * 10,
        "sample_count": 0,
        "override_rate_trend": {"this_month_pct": None, "last_month_pct": None, "direction": "no_data"},
        "avg_processing_time_ms": None,
    }


# --- malformed inference_log data (code review: response-shaping hardening) ---------------


def test_confidence_outside_zero_to_one_is_discarded_not_corrupted(client, store):
    # Code review fix: a negative confidence previously produced a negative Python list
    # index, silently corrupting a bucket via wraparound instead of being discarded.
    store["inference_log"] = [
        _inference(1, confidence=-0.5),
        _inference(2, confidence=1.5),
        _inference(3, confidence=0.75),  # the only valid one -- bucket 7
    ]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    ai = res.get_json()["ai_metrics"]
    assert ai["confidence_histogram"] == [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]
    assert sum(ai["confidence_histogram"]) == 1


def test_nan_confidence_is_discarded_not_a_500(client, store):
    # Code review fix: int(nan * 10) previously raised ValueError, uncaught outside the
    # try/except psycopg2.Error block -- a raw 500 instead of a clean, discarded row.
    store["inference_log"] = [_inference(1, confidence=float("nan"))]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["ai_metrics"]["confidence_histogram"] == [0] * 10


def test_non_dict_input_features_does_not_crash(client, store):
    # Code review fix: `features or {}` kept a non-dict truthy JSONB value as-is, and
    # `.get(...)` on a list/string raises AttributeError, uncaught -> 500.
    row = _inference(1, confidence=0.5)
    row["input_features"] = ["not", "a", "dict"]  # type: ignore[assignment]  # intentionally wrong type to test runtime guard
    store["inference_log"] = [row]
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    assert res.status_code == 200
    assert res.get_json()["ai_metrics"]["avg_processing_time_ms"] is None


def test_non_finite_processing_time_string_is_discarded(client, store):
    # Code review fix: Python's float() happily parses "Infinity"/"NaN" strings into a
    # non-finite float, which would otherwise reach the average and produce an invalid JSON
    # token in the response.
    store["inference_log"] = [
        _inference(1, processing_ms=None),
        _inference(2, confidence=0.5, was_overridden=False),
    ]
    store["inference_log"][0]["input_features"] = {"ai_processing_time_ms": "Infinity"}
    store["inference_log"][1]["input_features"] = {"ai_processing_time_ms": 300.0}
    res = client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    assert res.get_json()["ai_metrics"]["avg_processing_time_ms"] == 300.0


# --- audit ---------------------------------------------------------------------------------


def test_view_is_audited(client, store):
    client.get("/api/v1/admin/analytics", headers=_auth())
    events = [a["event"] for a in store["audit"]]
    assert "admin_viewed_analytics" in events


def test_audit_metadata_records_the_range_viewed(client, store):
    # Code review fix: the audit entry previously only logged ip_address, not the range the
    # admin actually viewed -- a weaker forensic record than list_cases's own audit write.
    client.get("/api/v1/admin/analytics?from=2026-06-01&to=2026-07-15", headers=_auth())
    event = next(a for a in store["audit"] if a["event"] == "admin_viewed_analytics")
    assert event["metadata"]["from"] == "2026-06-01"
    assert event["metadata"]["to"] == "2026-07-15"
