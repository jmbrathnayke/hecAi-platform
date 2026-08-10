"""Tests for the research seed plan (Story 7.4, AC1/AC2).

`build_plan()` is pure — no DB, no clock — precisely so the distribution guarantees can be
asserted here, in the ordinary CI suite, instead of only being observable after a live seed run.
The scripts that talk to Postgres are covered by tests/scenarios/ (skipped without a real DB).

Every quota assertion below is exact (`== 15`, not `>= 10`): the plan assigns by slicing a
shuffled index list rather than sampling, so "approximately right" would hide a real regression.
"""
from datetime import datetime, timedelta, timezone

import pytest

from scripts._seed_common import (
    CONFIDENCE_MAX,
    CONFIDENCE_MIN,
    MODEL_CLASSES,
    PILOT_DISTRICTS,
    SEED_DAMAGE_CATEGORIES,
    build_plan,
    load_pilot_divisions,
)

NOW = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def divisions():
    return load_pilot_divisions()


@pytest.fixture(scope="module")
def plan(divisions):
    return build_plan(50, now=NOW, divisions=divisions)


def test_produces_exactly_the_requested_count(plan):
    assert len(plan) == 50


def test_all_four_pilot_districts_are_represented(plan):
    assert {c["district"] for c in plan} == set(PILOT_DISTRICTS)


def test_status_distribution_is_exact(plan):
    from collections import Counter
    assert Counter(c["status"] for c in plan) == {
        "Submitted": 20, "Under Review": 10, "Approved": 13, "Rejected": 7,
    }


def test_status_split_stays_exact_at_other_counts(divisions):
    from collections import Counter
    for count in (37, 150, 213):
        counts = Counter(c["status"] for c in build_plan(count, now=NOW, divisions=divisions))
        assert sum(counts.values()) == count, count
        assert set(counts) == {"Submitted", "Under Review", "Approved", "Rejected"}, count


def test_damage_categories_never_include_none_or_a_model_class(plan):
    """A 'none' category — or a model class name in cases.damage_category — falls outside
    _DAMAGE_TYPE_MAP, so estimate_and_store() returns None and the case silently gets no
    compensation row. This is the single easiest way to break AC2."""
    used = {c["damage_category"] for c in plan}
    assert used <= set(SEED_DAMAGE_CATEGORIES)
    assert "none" not in used
    assert not used & set(MODEL_CLASSES)


def test_confidence_spans_the_full_declared_range(plan):
    confidences = [c["confidence"] for c in plan]
    assert min(confidences) == CONFIDENCE_MIN
    assert max(confidences) == CONFIDENCE_MAX
    assert all(CONFIDENCE_MIN <= v <= CONFIDENCE_MAX for v in confidences)


def test_override_rate_is_exactly_thirty_percent(plan):
    """AC3 asserts migration 006's override-rate query returns exactly 0.30, which only holds if
    the plan produces exactly 15 overridden cases out of 50 AND one inference row per case."""
    assert sum(1 for c in plan if c["was_overridden"]) == 15


def test_an_override_always_changes_the_class(plan):
    """Story 3.4 decision D1: a same-category 'override' is recorded as a non-override so the
    NFR-6.3 metric stays honest. An override that kept the class would inflate the rate."""
    for case in plan:
        if case["was_overridden"]:
            assert case["override_category"] in MODEL_CLASSES
            assert case["override_category"] != case["prediction"]
        else:
            assert case["override_category"] is None


def test_ground_truth_is_present_and_not_perfectly_diagonal(plan):
    """A confusion matrix computed from ground_truth == prediction on every row would be a
    fabricated 100% accuracy. The disagreement count is arbitrary synthetic labelling, but it
    must be non-zero and it must not silently drift."""
    assert all(c["ground_truth"] in MODEL_CLASSES for c in plan)
    assert sum(1 for c in plan if c["ground_truth"] != c["prediction"]) == 8


def test_all_three_classes_appear_so_the_matrix_is_not_degenerate(plan):
    seen = set()
    for case in plan:
        seen.add(case["prediction"])
        seen.add(case["ground_truth"])
        if case["override_category"]:
            seen.add(case["override_category"])
    assert seen == set(MODEL_CLASSES)


def test_offline_ids_are_unique_and_reproducible(divisions):
    """Idempotency (AC4) rests entirely on these UUIDs being recomputable: a re-run finds the
    same ids already present and skips them."""
    first = build_plan(50, now=NOW, divisions=divisions)
    second = build_plan(50, now=NOW, divisions=divisions)
    ids = [c["offline_id"] for c in first]
    assert len(set(ids)) == 50
    assert ids == [c["offline_id"] for c in second]


def test_whole_plan_is_deterministic(divisions):
    assert build_plan(50, now=NOW, divisions=divisions) == build_plan(
        50, now=NOW, divisions=divisions
    )


def test_submitted_at_spreads_across_twelve_months(plan):
    """Left to the column default every row would be stamped NOW(), collapsing Story 7.1's
    'last 12 months' trend chart into one spike."""
    dates = [c["submitted_at"] for c in plan]
    assert max(dates) <= NOW
    assert min(dates) >= NOW - timedelta(days=366)
    assert (max(dates) - min(dates)).days >= 350
    assert len({d.strftime("%Y-%m") for d in dates}) >= 12


def test_decided_cases_have_a_processing_gap_and_open_ones_do_not(plan):
    """admin.py's avg_processing_days KPI is updated_at - submitted_at; equal timestamps on
    decided cases report a meaningless 0.0 days."""
    for case in plan:
        assert case["updated_at"] >= case["submitted_at"]
        assert case["updated_at"] <= NOW
        if case["status"] in ("Approved", "Rejected"):
            assert case["updated_at"] > case["submitted_at"] or case["submitted_at"] == NOW
        else:
            assert case["updated_at"] == case["submitted_at"]


def test_divisions_are_known_to_the_compensation_model(plan, divisions):
    """An unknown division falls through _prior_year_features() to the {0.0, -1.0, 0.0} sentinel,
    collapsing every estimate in that district onto the same uninformative value."""
    for case in plan:
        assert case["ds_division_id"] in divisions[case["district"]]


def test_approval_factor_moves_the_human_figure_off_the_model_figure(plan):
    """If approved_amount equalled the estimate exactly, MAE would be identically zero — another
    fabricated-perfect artifact."""
    factors = {c["approval_factor"] for c in plan}
    assert len(factors) > 1
    assert all(0.7 <= f <= 1.3 for f in factors)
