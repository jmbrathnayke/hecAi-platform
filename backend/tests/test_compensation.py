"""Tests for backend/app/infrastructure/ml/compensation.py (Story 5.2).

Most tests use a fake model bundle (deterministic, fast, no disk I/O) so the pure logic
--damage/district resolution, severity multiplier, capping, storage-- is exercised
independently of the real RF model's actual predictions. A couple of integration tests at
the bottom load the REAL rf_compensation_v2.joblib bundle to confirm end-to-end wiring
against production artifacts (mirrors the manual smoke test run during Task 1c).

The DB is faked (no Postgres in CI): FakeCursor implements just the two SQL statements
estimate_and_store() issues, mirroring test_sync.py's pattern.
"""
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pytest

from app.infrastructure.ml import compensation


class FakeStage:
    """Stand-in for a fitted sklearn Pipeline's .predict(). `value` is returned for every
    call regardless of X -- these tests aren't exercising sklearn's own correctness (that's
    train_rf_compensation_v2.py's job), just compensation.py's logic around it."""

    def __init__(self, value):
        self.value = value

    def predict(self, X):
        return np.array([self.value])


def make_bundle(gate: bool, log_amount: float, version="v2", dataset="compensation_long.csv"):
    return {
        "clf": FakeStage(1 if gate else 0),
        "reg": FakeStage(log_amount),
        "meta": {"version": version, "dataset": dataset},
    }


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = None

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        if sql == "SAVEPOINT compensation_estimate":
            self.store.setdefault("savepoint_events", []).append("SAVEPOINT")
            self._result = None
        elif sql == "RELEASE SAVEPOINT compensation_estimate":
            self.store.setdefault("savepoint_events", []).append("RELEASE")
            self._result = None
        elif sql == "ROLLBACK TO SAVEPOINT compensation_estimate":
            self.store.setdefault("savepoint_events", []).append("ROLLBACK")
            self._result = None
        elif "SELECT cap_amount_lkr FROM compensation_caps" in sql:
            district, damage_type = params
            cap = self.store["caps"].get((district, damage_type))
            self._result = (cap,) if cap is not None else None
        elif "INSERT INTO compensation_estimates" in sql:
            if self.store.get("fail_on_insert"):
                # Simulates a psycopg2.Error from this module's own SQL (e.g. a
                # constraint violation) to verify the SAVEPOINT/ROLLBACK isolation.
                raise RuntimeError("simulated DB error on INSERT INTO compensation_estimates")
            (case_id, amount_lkr, raw_estimate_lkr, capped, feature_values_json,
             model_version, dataset_version) = params
            row = {
                "case_id": case_id, "amount_lkr": amount_lkr, "raw_estimate_lkr": raw_estimate_lkr,
                "capped": capped, "feature_values_json": feature_values_json,
                "model_version": model_version, "dataset_version": dataset_version,
            }
            if "ON CONFLICT (case_id) DO UPDATE" in sql:
                # Mirrors the UNIQUE(case_id) upsert: the existing row is replaced, never duplicated.
                self.store["estimates"] = [e for e in self.store["estimates"]
                                           if e["case_id"] != case_id] + [row]
                self.store.setdefault("upserts", 0)
                self.store["upserts"] += 1
            elif any(e["case_id"] == case_id for e in self.store["estimates"]):
                # A plain INSERT against an existing case_id is a UNIQUE violation in Postgres.
                raise RuntimeError("duplicate key value violates unique constraint")
            else:
                self.store["estimates"].append(row)
            self._result = None
        else:  # pragma: no cover - unexpected SQL
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._result


@pytest.fixture
def store():
    return {"caps": {}, "estimates": []}


@pytest.fixture(autouse=True)
def reset_module_caches():
    """These are lazily-loaded module globals -- reset between tests so one test's
    monkeypatched bundle/lookup never leaks into the next."""
    compensation._bundle = None
    compensation._crop_bundle = None
    compensation._prior_year_lookup = None
    compensation._district_reference = None
    yield
    compensation._bundle = None
    compensation._crop_bundle = None
    compensation._prior_year_lookup = None
    compensation._district_reference = None


SUBMITTED_AT = datetime(2026, 7, 13, tzinfo=timezone.utc)


# --- _map_damage_category ---------------------------------------------------------------


@pytest.mark.parametrize("category,expected", [
    ("crop", "property"),
    ("property", "property"),
    ("combined", "property"),
    ("none", None),
    ("something-unrecognized", None),
])
def test_map_damage_category(category, expected):
    assert compensation._map_damage_category(category) == expected


# --- _resolve_district -------------------------------------------------------------------


def test_resolve_district_uses_direct_district_arg_without_lookup():
    compensation._district_reference = {}  # would miss if a lookup were attempted
    district, ds_division = compensation._resolve_district("අනුරාධපුරය", "ඉපලෝගම")
    assert district == "අනුරාධපුරය"
    assert ds_division == "ඉපලෝගම"


def test_resolve_district_looks_up_known_ds_division_id():
    compensation._district_reference = {"ඉපලෝගම": "අනුරාධපුරය"}
    district, ds_division = compensation._resolve_district(None, "ඉපලෝගම")
    assert district == "අනුරාධපුරය"
    assert ds_division == "ඉපලෝගම"


def test_resolve_district_none_ds_division_id_falls_back_to_unknown():
    compensation._district_reference = {"ඉපලෝගම": "අනුරාධපුරය"}
    assert compensation._resolve_district(None, None) == ("unknown", "unknown")


def test_resolve_district_unrecognized_ds_division_id_falls_back_to_unknown():
    compensation._district_reference = {"ඉපලෝගම": "අනුරාධපුරය"}
    assert compensation._resolve_district(None, "some-other-place") == ("unknown", "unknown")


# --- _severity_multiplier -----------------------------------------------------------------


@pytest.mark.parametrize("severity,expected", [
    ("Minor", 0.7),
    ("Moderate", 1.0),
    ("Severe", 1.3),
    ("None", 1.0),
    (None, 1.0),
    ("unrecognized-value", 1.0),
])
def test_severity_multiplier(severity, expected):
    assert compensation._severity_multiplier(severity) == expected


# --- estimate_and_store: skip conditions --------------------------------------------------


def test_none_damage_category_skips_estimation_no_row_written(store):
    compensation._bundle = make_bundle(gate=True, log_amount=10.0)
    result = compensation.estimate_and_store(
        FakeCursor(store), 1, "none", None, SUBMITTED_AT
    )
    assert result is None
    assert store["estimates"] == []


def test_unrecognized_damage_category_skips_estimation(store):
    compensation._bundle = make_bundle(gate=True, log_amount=10.0)
    result = compensation.estimate_and_store(
        FakeCursor(store), 1, "not-a-real-category", None, SUBMITTED_AT
    )
    assert result is None
    assert store["estimates"] == []


def test_model_unavailable_skips_estimation_no_exception(store):
    compensation._bundle = "unavailable"
    result = compensation.estimate_and_store(
        FakeCursor(store), 1, "crop", None, SUBMITTED_AT
    )
    assert result is None
    assert store["estimates"] == []


def test_model_file_missing_degrades_gracefully(store, monkeypatch):
    monkeypatch.setattr(compensation, "MODEL_PATH", "/nonexistent/path/model.joblib")
    result = compensation.estimate_and_store(
        FakeCursor(store), 1, "crop", None, SUBMITTED_AT
    )
    assert result is None
    assert store["estimates"] == []


# --- estimate_and_store: happy path + capping ----------------------------------------------


def test_happy_path_no_gate_produces_zero_amount(store):
    compensation._bundle = make_bundle(gate=False, log_amount=99.0)  # gate=False -> amount 0
    result = compensation.estimate_and_store(
        FakeCursor(store), 42, "crop", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["amount_lkr"] == 0.0
    assert result["raw_estimate_lkr"] == 0.0
    assert result["capped"] is False
    assert len(store["estimates"]) == 1
    assert store["estimates"][0]["case_id"] == 42
    assert store["estimates"][0]["model_version"] == "rf_compensation_v2"
    assert store["estimates"][0]["dataset_version"] == "compensation_long.csv"


def test_happy_path_gate_true_produces_expm1_amount(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["amount_lkr"] == pytest.approx(100000.0, rel=1e-6)
    assert result["raw_estimate_lkr"] == pytest.approx(100000.0, rel=1e-6)
    assert result["capped"] is False


def test_cap_present_and_exceeded_clamps_amount(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    store["caps"][("unknown", "property")] = 50000.0
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["capped"] is True
    assert result["amount_lkr"] == 50000.0
    assert result["raw_estimate_lkr"] == pytest.approx(100000.0, rel=1e-6)  # raw preserved


def test_cap_present_but_not_exceeded_does_not_clamp(store):
    log_amount = np.log1p(30000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    store["caps"][("unknown", "property")] = 50000.0
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["capped"] is False
    assert result["amount_lkr"] == pytest.approx(30000.0, rel=1e-6)


def test_cap_absent_never_clamps(store):
    log_amount = np.log1p(999999.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["capped"] is False
    assert result["amount_lkr"] == pytest.approx(999999.0, rel=1e-6)


# --- estimate_and_store: district resolution (AC7) ------------------------------------------


def test_ds_division_id_none_uses_unknown_district_and_still_succeeds(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert result["feature_values"]["district"] == "unknown"
    assert result["feature_values"]["ds_division"] == "unknown"


def test_explicit_district_arg_used_directly(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", "ඉපලෝගම", SUBMITTED_AT, district="අනුරාධපුරය",
    )
    assert result is not None
    assert result["feature_values"]["district"] == "අනුරාධපුරය"
    assert result["feature_values"]["ds_division"] == "ඉපලෝගම"


# --- estimate_and_store: severity multiplier (PO-ratified scope addition) -------------------


def test_severe_severity_multiplies_raw_estimate_before_capping(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    store["caps"][("unknown", "property")] = 120000.0
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT, ai_severity="Severe",
    )
    # 100000 * 1.3 = 130000, which now exceeds the 120000 cap -> still correctly capped
    assert result is not None
    assert result["raw_estimate_lkr"] == pytest.approx(130000.0, rel=1e-6)
    assert result["capped"] is True
    assert result["amount_lkr"] == 120000.0
    assert result["feature_values"]["ai_severity"] == "Severe"
    assert result["feature_values"]["severity_multiplier"] == 1.3


def test_absent_ai_severity_is_neutral_not_zero(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT, ai_severity=None,
    )
    assert result is not None
    assert result["raw_estimate_lkr"] == pytest.approx(100000.0, rel=1e-6)
    assert result["feature_values"]["severity_multiplier"] == 1.0


# --- feature_values_json contains no PII ----------------------------------------------------


def test_feature_values_contains_no_pii(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    keys = set(result["feature_values"].keys())
    assert keys == {
        # the model's own inputs
        "damage_type", "district", "ds_division", "year", "prior_year_amount",
        "prior_year_incident_count", "prior_year_had_payout", "ai_severity",
        "severity_multiplier",
        # provenance, stored with every estimate so a row can be read without the documentation
        "model_version", "synthetic_model", "decision_support_only", "is_final_decision",
    }
    for pii_key in ("nic", "offline_id", "submitter_identity_hash", "officer_id"):
        assert pii_key not in keys


# --- integration: the REAL trained bundle ----------------------------------------------------


class RealFakeCursor(FakeCursor):
    """Same fake DB, but used against the real joblib bundle -- confirms the shipped
    model actually loads and predicts through this module's exact call path."""


def test_real_bundle_loads_and_predicts_for_a_known_division(store):
    result = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "crop", "ඉපලෝගම", SUBMITTED_AT, district="අනුරාධපුරය",
    )
    assert result is not None
    assert result["amount_lkr"] >= 0
    assert result["model_version"] == "rf_compensation_v2"
    assert result["dataset_version"] == "compensation_long.csv"


def test_real_bundle_degrades_gracefully_for_unknown_district(store):
    result = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "property", None, SUBMITTED_AT,
    )
    assert result is not None  # AC7: must not crash, must still produce SOME estimate
    assert result["feature_values"]["district"] == "unknown"


# --- Code review fix: empty-string district/ds_division/ai_severity coerced to None -------


def test_empty_string_district_and_ds_division_treated_as_absent(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", "", SUBMITTED_AT, district="", ai_severity="",
    )
    assert result is not None
    assert result["feature_values"]["district"] == "unknown"
    assert result["feature_values"]["ds_division"] == "unknown"
    assert result["feature_values"]["severity_multiplier"] == 1.0  # empty string -> neutral


# --- Code review fix: SAVEPOINT isolation so a DB error here can't poison the caller's --
# --- shared transaction (case insert + audit log must survive an estimation failure)   --


def test_happy_path_issues_savepoint_then_release(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is not None
    assert store["savepoint_events"] == ["SAVEPOINT", "RELEASE"]


def test_db_error_on_insert_rolls_back_to_savepoint_not_the_whole_transaction(store):
    log_amount = np.log1p(50000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    store["fail_on_insert"] = True
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT
    )
    # Never raises out to the caller (CRITICAL #4) -- degrades to None.
    assert result is None
    # No partial/corrupt row was left behind.
    assert store["estimates"] == []
    # Crucially: ROLLBACK TO SAVEPOINT was issued, not a bare swallow -- confirms the
    # caller's shared connection/transaction is left in a valid (not aborted) state,
    # so its own commit() on exit won't silently discard the case row + audit log.
    assert store["savepoint_events"] == ["SAVEPOINT", "ROLLBACK"]


def test_savepoint_open_failure_itself_degrades_gracefully(store, monkeypatch):
    """If even opening the SAVEPOINT fails (e.g. the connection is already in a bad
    state), estimate_and_store must still return None rather than raise."""
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(1000.0))

    class SavepointFailsCursor(FakeCursor):
        def execute(self, sql, params=()):
            if sql == "SAVEPOINT compensation_estimate":
                raise RuntimeError("connection already aborted")
            return super().execute(sql, params)

    result = compensation.estimate_and_store(
        SavepointFailsCursor(store), 7, "property", None, SUBMITTED_AT
    )
    assert result is None
    assert store["estimates"] == []


# --- estimate_and_store(replace=True): officer-assessment regeneration -----------------------
#
# The officer's on-device classification supplies an ai_severity the citizen submission never has,
# so the AI-assisted estimate is regenerated for the SAME case. compensation_estimates is UNIQUE on
# case_id: a plain second INSERT is a constraint violation (swallowed by the savepoint, estimate
# silently lost), which is exactly why the regeneration path must upsert.


def test_replace_regenerates_an_existing_estimate_without_duplicating_it(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    first = compensation.estimate_and_store(FakeCursor(store), 9, "property", None, SUBMITTED_AT)
    assert first["amount_lkr"] == pytest.approx(100000.0, rel=1e-6)

    second = compensation.estimate_and_store(
        FakeCursor(store), 9, "property", None, SUBMITTED_AT, ai_severity="Severe", replace=True,
    )
    assert second is not None
    # Severe multiplies by 1.3 -- the regenerated figure reflects the officer's assessment.
    assert second["amount_lkr"] == pytest.approx(130000.0, rel=1e-6)
    assert [e["case_id"] for e in store["estimates"]] == [9]
    assert store["estimates"][0]["amount_lkr"] == pytest.approx(130000.0, rel=1e-6)
    assert store["upserts"] == 1


def test_without_replace_a_second_estimate_for_the_same_case_is_not_written(store):
    log_amount = np.log1p(100000.0)
    compensation._bundle = make_bundle(gate=True, log_amount=log_amount)
    compensation.estimate_and_store(FakeCursor(store), 9, "property", None, SUBMITTED_AT)
    again = compensation.estimate_and_store(
        FakeCursor(store), 9, "property", None, SUBMITTED_AT, ai_severity="Severe",
    )
    # The unique violation is isolated by the savepoint and reported as "no estimate", never raised.
    assert again is None
    assert store["savepoint_events"][-1] == "ROLLBACK"
    assert store["estimates"][0]["amount_lkr"] == pytest.approx(100000.0, rel=1e-6)


def test_replace_on_a_case_with_no_estimate_simply_inserts(store):
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(50000.0))
    result = compensation.estimate_and_store(
        FakeCursor(store), 11, "crop", None, SUBMITTED_AT, ai_severity="Minor", replace=True,
    )
    assert result["amount_lkr"] == pytest.approx(35000.0, rel=1e-6)
    assert len(store["estimates"]) == 1
