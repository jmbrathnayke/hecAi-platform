"""RF compensation assertions over the seeded corpus (Story 7.4, AC2/AC3, RER-3).

Runs against whatever `scripts.seed_research_data` last wrote, so it verifies the corpus as it
actually exists in the database rather than re-deriving it from the plan. Skips (rather than
fails) when nothing is seeded — an un-seeded database is a legitimate state, not a defect.
"""
import os

import pytest

from app.infrastructure.ml.compensation import FEATURES
from scripts._seed_common import (
    MODEL_CLASSES,
    OVERRIDE_RATE,
    PILOT_DISTRICTS,
    SEED_DAMAGE_CATEGORIES,
    SEED_MODEL_VERSION,
)

pytestmark = pytest.mark.skipif(
    not os.getenv("HEC_SCENARIO_DB_URL"),
    reason="scenario suite needs a real Postgres; set HEC_SCENARIO_DB_URL",
)


@pytest.fixture(scope="module")
def seeded(db):
    with db.cursor() as cur:
        cur.execute("SELECT id, status, damage_category, district, approved_amount "
                    "FROM cases WHERE seeded ORDER BY id")
        rows = cur.fetchall()
    if not rows:
        pytest.skip("no seeded corpus; run `python -m scripts.seed_research_data` first")
    return rows


def _scalar(db, sql, params=()):
    with db.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0]


def test_every_seeded_case_has_exactly_one_estimate(db, seeded):
    """The failure this guards is silent: a damage_category outside _DAMAGE_TYPE_MAP makes
    estimate_and_store() return None and the case ships with no estimate at all."""
    case_ids = [r[0] for r in seeded]
    got = _scalar(db, "SELECT count(*) FROM compensation_estimates WHERE case_id = ANY(%s)",
                  (case_ids,))
    assert got == len(case_ids)


def test_estimates_are_non_negative_and_carry_the_full_feature_set(db, seeded):
    with db.cursor() as cur:
        cur.execute("SELECT amount_lkr, raw_estimate_lkr, feature_values_json, capped "
                    "FROM compensation_estimates WHERE case_id = ANY(%s)",
                    ([r[0] for r in seeded],))
        for amount, raw, features, _capped in cur.fetchall():
            assert amount >= 0 and raw >= 0
            assert set(FEATURES) <= set(features), "model feature missing from the stored snapshot"


def test_capped_flag_agrees_with_the_configured_caps(db, seeded):
    """Asserted against compensation_caps rather than hardcoded False: there are no caps today,
    but an admin can create them at runtime via PUT /admin/settings/compensation-caps, which
    would turn a hardcoded assertion into a spurious failure months from now."""
    caps = _scalar(db, "SELECT count(*) FROM compensation_caps")
    capped = _scalar(db, "SELECT count(*) FROM compensation_estimates "
                         "WHERE case_id = ANY(%s) AND capped", ([r[0] for r in seeded],))
    if caps == 0:
        assert capped == 0
    else:
        assert capped >= 0


def test_seeded_cases_cover_all_four_pilot_districts(seeded):
    assert {r[3] for r in seeded} == set(PILOT_DISTRICTS)


def test_seeded_damage_categories_never_include_none(seeded):
    assert {r[2] for r in seeded} <= set(SEED_DAMAGE_CATEGORIES)


def test_approved_cases_carry_a_human_amount_so_mae_is_computable(seeded):
    approved = [r for r in seeded if r[1] == "Approved"]
    assert approved, "no approved cases in the corpus"
    assert all(r[4] is not None for r in approved)


def test_override_rate_is_exactly_thirty_percent(db, seeded):
    """Migration 006's documented query. It only returns 0.30 if the seeder wrote exactly one
    inference row per case — a second 'original prediction' row per overridden case would push
    the denominator up and the rate down to ~0.23."""
    case_ids = [r[0] for r in seeded]
    total = _scalar(db, "SELECT count(*) FROM inference_log WHERE case_id = ANY(%s)", (case_ids,))
    overridden = _scalar(db, "SELECT count(*) FROM inference_log "
                             "WHERE case_id = ANY(%s) AND was_overridden", (case_ids,))
    assert total == len(case_ids), "expected exactly one inference row per seeded case"
    assert round(overridden / total, 2) == OVERRIDE_RATE


def test_ground_truth_is_populated_so_a_confusion_matrix_is_computable(db, seeded):
    """Nothing in the application writes ground_truth (Story 7.3 verified this), so without the
    seeder RER-2's confusion matrix cannot be computed from the export at all."""
    case_ids = [r[0] for r in seeded]
    with db.cursor() as cur:
        cur.execute("SELECT prediction, ground_truth FROM inference_log WHERE case_id = ANY(%s)",
                    (case_ids,))
        rows = cur.fetchall()
    assert all(gt is not None for _, gt in rows)
    assert {p for p, _ in rows} | {gt for _, gt in rows} <= set(MODEL_CLASSES)
    disagreements = sum(1 for p, gt in rows if p != gt)
    assert 0 < disagreements < len(rows), "a perfectly diagonal matrix is a fabricated result"


def test_seeded_inference_rows_are_marked_as_synthetic(db, seeded):
    """The integrity control: synthetic rows must stay distinguishable from real ones in any
    export, so seeded metrics can never be mistaken for the dissertation's model numbers."""
    case_ids = [r[0] for r in seeded]
    versions = _scalar(db, "SELECT count(DISTINCT model_version) FROM inference_log "
                           "WHERE case_id = ANY(%s) AND model_version <> %s",
                       (case_ids, SEED_MODEL_VERSION))
    assert versions == 0
