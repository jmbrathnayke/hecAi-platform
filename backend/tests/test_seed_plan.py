"""Tests for the research seed plan (Story 7.4, AC1/AC2).

`build_plan()` is pure — no DB, no clock — precisely so the distribution guarantees can be
asserted here, in the ordinary CI suite, instead of only being observable after a live seed run.
The scripts that talk to Postgres are covered by tests/scenarios/ (skipped without a real DB).

Every quota assertion below is exact (`== 15`, not `>= 10`): the plan assigns by drawing from
shuffled index lists rather than sampling, so "approximately right" would hide a real regression.

Marginal assertions alone are not enough, which review proved: the first version of `build_plan`
sliced every quota off ONE shuffled list, so all 15 overrides landed on Submitted cases and every
Rejected case was officer-assisted, while all of the marginal tests passed. The
"independence between dimensions" block at the bottom is what catches that class of bug.
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
    for count in (12, 37, 150, 213):
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


def test_every_class_appears_as_a_PREDICTION(plan):
    """The predicted axis specifically — this is the assertion that matters for RER-2.

    The original version of this test unioned prediction + ground_truth + override_category
    before asserting, so it passed while `no_damage` never appeared as a prediction at all.
    That left the confusion matrix with an all-zero predicted-no_damage row: precision 0/0 and
    recall 0 by construction rather than by data. Assert on each axis separately.
    """
    assert {c["prediction"] for c in plan} == set(MODEL_CLASSES)


def test_every_class_appears_as_a_GROUND_TRUTH(plan):
    assert {c["ground_truth"] for c in plan} == set(MODEL_CLASSES)


def test_confusion_matrix_has_no_empty_row_or_column(plan):
    """Directly assert the property the two tests above exist to protect."""
    from collections import Counter
    cm = Counter((c["ground_truth"], c["prediction"]) for c in plan)
    for cls in MODEL_CLASSES:
        assert sum(v for (t, _), v in cm.items() if t == cls) > 0, f"empty truth row: {cls}"
        assert sum(v for (_, p), v in cm.items() if p == cls) > 0, f"empty pred column: {cls}"


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
    decided cases report a meaningless 0.0 days.

    No escape clause. The earlier version ended `... or case["submitted_at"] == NOW`, which
    whitelisted exactly the zero-gap case the assertion exists to prevent — index 0 has
    age 0, so a decided status landing there produced 0.0 days and the test still passed.
    Decided statuses are now restricted to cases at least MIN_DECISION_AGE_DAYS old.
    """
    for case in plan:
        assert case["updated_at"] >= case["submitted_at"]
        assert case["updated_at"] <= NOW
        if case["status"] in ("Approved", "Rejected"):
            assert case["updated_at"] > case["submitted_at"], f"zero-day decision at {case['index']}"
        else:
            assert case["updated_at"] == case["submitted_at"]


# --- independence between dimensions -------------------------------------------------------
# These exist because every quota was originally sliced off ONE shuffled list. Each marginal was
# correct — 15 overrides, 20 Submitted, 10 officer cases — and every marginal test passed, while
# the dimensions were perfectly nested: 15/15 overrides on Submitted, 0 on any decided case,
# 7/7 Rejected officer-assisted. Marginal assertions cannot see that; cross-tabs can.

def test_overrides_are_not_confined_to_one_status(plan):
    statuses = {c["status"] for c in plan if c["was_overridden"]}
    assert len(statuses) >= 3, f"overrides only on {statuses} — quotas are correlated"


def test_officer_submissions_are_not_confined_to_one_status(plan):
    statuses = {c["status"] for c in plan if c["submitted_by_officer"]}
    assert len(statuses) >= 2, f"officer cases only on {statuses} — quotas are correlated"


def test_no_status_is_entirely_officer_assisted(plan):
    from collections import Counter
    total = Counter(c["status"] for c in plan)
    officer = Counter(c["status"] for c in plan if c["submitted_by_officer"])
    for status, n in total.items():
        assert officer[status] < n, f"100% of {status} cases are officer-assisted"


def test_severity_is_not_aliased_to_damage_category(plan):
    """`i % 3` for both made every crop case Minor, every property case Moderate, and so on —
    a severity-by-damage-type breakdown would have been a fabricated perfect diagonal. Any
    linear function of i mod 3 has the same problem, so these come from independent draws."""
    pairs = {(c["damage_category"], c["ai_severity"]) for c in plan}
    assert len(pairs) > len(SEED_DAMAGE_CATEGORIES), f"aliased: {sorted(pairs)}"


def test_locale_is_not_aliased_to_damage_category(plan):
    pairs = {(c["damage_category"], c["locale"]) for c in plan}
    assert len(pairs) > len(SEED_DAMAGE_CATEGORIES), f"aliased: {sorted(pairs)}"


def test_confidence_is_not_a_function_of_case_age(plan):
    """confidence = f(i) and submitted_at = g(i) with both monotone made confidence decline
    linearly over 12 months — a clean, entirely fabricated 'model degradation' signal."""
    import statistics
    ages = [(NOW - c["submitted_at"]).days for c in plan]
    conf = [c["confidence"] for c in plan]
    r = statistics.correlation(ages, conf)
    assert abs(r) < 0.5, f"confidence correlates with case age (r={r:+.3f})"


def test_divisions_are_known_to_the_compensation_model(plan):
    """An unknown division falls through _prior_year_features() to the {0.0, -1.0, 0.0} sentinel,
    collapsing every estimate in that district onto the same uninformative value.

    Asserted against the model's lookup file read independently here — the earlier version
    checked the plan against the very dict that generated it, so it was true by construction and
    could not fail for any implementation of load_pilot_divisions().
    """
    import json
    from app.infrastructure.ml.compensation import LOOKUP_PATH
    with open(LOOKUP_PATH, encoding="utf-8") as fh:
        keys = set(json.load(fh))
    for case in plan:
        key = f"{case['district']}|{case['ds_division_id']}|property"
        assert key in keys, f"division unknown to the RF prior-year lookup: {key}"


def test_approval_factor_is_never_exactly_one(plan):
    """A factor of exactly 1.0 makes approved_amount == the estimate, so that case contributes
    exactly zero to MAE. The previous formula hit 1.000 whenever (i*7) % 11 == 5."""
    assert all(c["approval_factor"] != 1.0 for c in plan)


def test_approval_factor_moves_the_human_figure_off_the_model_figure(plan):
    """If approved_amount equalled the estimate exactly, MAE would be identically zero — another
    fabricated-perfect artifact."""
    factors = {c["approval_factor"] for c in plan}
    assert len(factors) > 1
    assert all(0.7 <= f <= 1.3 for f in factors)
    assert all(abs(f - 1.0) > 0.01 for f in factors), "a factor at ~1.0 contributes 0 to MAE"
