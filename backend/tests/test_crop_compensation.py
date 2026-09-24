"""Crop compensation routing (synthetic_crop_compensation_v1).

THE DEFECT THIS BRANCH EXISTS TO REMOVE. rf_compensation_v2 was fit on the historical DWC dataset,
whose damage_type vocabulary is {death, injury, property}. The incident form and MobileNetV2 both
speak crop/property, so every crop report was collapsed onto "property" and priced by a model that
had never seen a field -- measured at R2 = -0.277 on the deployed serving path. These tests pin the
routing, the refusal to guess a crop, and the provenance that lets someone reading a stored row tell
which model produced it and on what data.

THE CROP MODEL IS TRAINED ON SYNTHETIC DATA. Nothing here asserts an amount is correct, because no
test can establish that from generated rows. What is asserted is that the officer's inputs reach
predict(), that the figures come from the model rather than a lookup table, and that the synthetic
provenance survives into storage.
"""
from datetime import datetime, timezone

import numpy as np
import pytest

from app.infrastructure.ml import compensation
from tests.test_compensation import FakeCursor, RealFakeCursor, make_bundle

SUBMITTED_AT = datetime(2026, 7, 13, tzinfo=timezone.utc)
CROP_ARGS = {"crop_type": "paddy", "affected_area_acres": 2.0, "damage_extent_percent": 75.0}
GALNEWA, ANURADHAPURA = "ගල්නැව", "අනුරාධපුරය"

real_crop_model = pytest.mark.skipif(
    not compensation.is_crop_model_available(),
    reason="synthetic_crop_compensation_v1.joblib not present",
)


@pytest.fixture
def store():
    return {"caps": {}, "estimates": []}


@pytest.fixture(autouse=True)
def reset_module_caches():
    for name in ("_bundle", "_crop_bundle", "_prior_year_lookup", "_district_reference"):
        setattr(compensation, name, None)
    yield
    for name in ("_bundle", "_crop_bundle", "_prior_year_lookup", "_district_reference"):
        setattr(compensation, name, None)


# --- server-side validation -------------------------------------------------------------------


@pytest.mark.parametrize("crop_type,acres,percent,expected", [
    ("paddy", 2.0, 75.0, ("paddy", 2.0, 75.0)),
    ("banana", 0.5, 100.0, ("banana", 0.5, 100.0)),
    ("bada_irigu", 3.5, 15.0, ("bada_irigu", 3.5, 15.0)),
    ("coconut", 1.0, 50.0, ("coconut", 1.0, 50.0)),
    ("vegetable", 0.1, 20.0, ("vegetable", 0.1, 20.0)),
    ("mango", 2.0, 75.0, None),        # not one of the five the model was fit on
    ("PADDY", 2.0, 75.0, None),        # the whitelist is exact, not case-folded
    (None, 2.0, 75.0, None),
    ("paddy", 0, 75.0, None),          # zero area is not an assessment
    ("paddy", -1.0, 75.0, None),
    ("paddy", 2.0, 0, None),
    ("paddy", 2.0, 101.0, None),       # more than all of it
    ("paddy", 250.0, 75.0, None),      # a mistyped 2.5 must not become a six-figure estimate
    ("paddy", "two", 75.0, None),
    ("paddy", None, 75.0, None),
    ("paddy", 2.0, None, None),
])
def test_crop_inputs_are_validated_server_side(crop_type, acres, percent, expected):
    assert compensation._crop_inputs(crop_type, acres, percent) == expected


def test_the_classifier_spelling_of_crop_damage_is_recognised():
    """`crop_damage` reaches this module from the officer path while the citizen form sends `crop`.
    Before both spellings were mapped, the classifier's own class id fell through to None and the
    case was left with no estimate at all -- a silent skip, not an error."""
    assert compensation._map_damage_category("crop_damage") == "property"
    assert compensation._map_damage_category("property_damage") == "property"
    assert compensation._map_damage_category("none") is None
    assert compensation._map_damage_category("nonsense") is None


# --- routing ------------------------------------------------------------------------------------


def test_crop_category_without_a_crop_type_falls_back_to_the_property_model(store):
    """A case filed before the crop model existed, or by an officer who did not know the crop,
    keeps its previous behaviour rather than losing its estimate."""
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(50000.0))
    result = compensation.estimate_and_store(FakeCursor(store), 7, "crop", None, SUBMITTED_AT)
    assert result is not None
    assert result["model_version"] == "rf_compensation_v2"
    assert result["synthetic_model"] is False


def test_an_unknown_crop_type_falls_back_rather_than_reaching_predict(store):
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(50000.0))
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "crop", None, SUBMITTED_AT,
        crop_type="mango", affected_area_acres=2.0, damage_extent_percent=75.0,
    )
    assert result["model_version"] == "rf_compensation_v2"


def test_no_damage_produces_no_estimate_whatever_crop_fields_are_sent(store):
    assert compensation.estimate_and_store(
        FakeCursor(store), 7, "none", None, SUBMITTED_AT, **CROP_ARGS,
    ) is None
    assert store["estimates"] == []


def test_property_category_never_routes_to_the_crop_model(store):
    """The mandatory regression. A crop type sent alongside a property category must not move the
    case onto the crop model -- routing is decided by the category, not by which fields arrived."""
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(50000.0))
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "property", None, SUBMITTED_AT, **CROP_ARGS,
    )
    assert result["model_version"] == "rf_compensation_v2"
    assert result["synthetic_model"] is False


def test_the_crop_model_missing_falls_back_to_the_property_model(store, monkeypatch):
    """Deploying the artifact and the code in either order must be safe."""
    monkeypatch.setattr(compensation, "CROP_MODEL_PATH", "no/such/file.joblib")
    compensation._bundle = make_bundle(gate=True, log_amount=np.log1p(50000.0))
    result = compensation.estimate_and_store(
        FakeCursor(store), 7, "crop", None, SUBMITTED_AT, **CROP_ARGS,
    )
    assert result["model_version"] == "rf_compensation_v2"
    assert result["synthetic_model"] is False


# --- the real synthetic bundle ------------------------------------------------------------------


@real_crop_model
@pytest.mark.parametrize("crop", ["paddy", "banana", "coconut"])
def test_the_real_crop_bundle_prices_each_crop_through_the_deployed_path(store, crop):
    result = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "crop_damage", GALNEWA, SUBMITTED_AT,
        district=ANURADHAPURA, ai_severity="Moderate",
        crop_type=crop, affected_area_acres=2.0, damage_extent_percent=75.0,
    )
    assert result is not None
    assert result["model_version"] == "synthetic_crop_compensation_v1"
    assert result["synthetic_model"] is True
    assert result["decision_support_only"] is True
    assert result["is_final_decision"] is False
    assert result["amount_lkr"] > 0
    assert result["feature_values"]["crop_type"] == crop
    assert result["feature_values"]["data_status"] == "SYNTHETIC"


@real_crop_model
def test_the_crop_choice_changes_the_estimate(store):
    """Not a hard-coded per-crop amount: the figures come from the trained model, and all this
    asserts is that the crop the officer chose reaches predict() and matters."""
    amounts = {}
    for crop in compensation.CROP_TYPES:
        amounts[crop] = compensation.estimate_and_store(
            RealFakeCursor(store), 1, "crop", GALNEWA, SUBMITTED_AT,
            district=ANURADHAPURA, ai_severity="Moderate", replace=True,
            crop_type=crop, affected_area_acres=2.0, damage_extent_percent=75.0,
        )["amount_lkr"]
    assert len(set(amounts.values())) > 1, amounts


@real_crop_model
def test_area_and_extent_reach_the_model_and_move_the_estimate(store):
    def price(acres, percent):
        return compensation.estimate_and_store(
            RealFakeCursor(store), 1, "crop", GALNEWA, SUBMITTED_AT,
            district=ANURADHAPURA, ai_severity="Moderate", replace=True,
            crop_type="paddy", affected_area_acres=acres, damage_extent_percent=percent,
        )["amount_lkr"]

    # affected_area_acres carries ~81% of the model's importance, so its effect must be
    # unmistakable if it is wired through correctly.
    assert price(0.25, 75.0) < price(1.0, 75.0) < price(3.0, 75.0)
    assert price(2.0, 20.0) != price(2.0, 90.0)


@real_crop_model
def test_an_area_beyond_the_training_range_is_flagged_not_hidden(store):
    """A random forest cannot extrapolate -- past its largest leaf it repeats that leaf's value.
    The estimate is still returned, because refusing a real assessment over a narrow training set
    would be worse, but the stored row says the model was asked about something it has not seen."""
    inside = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "crop", GALNEWA, SUBMITTED_AT, district=ANURADHAPURA,
        crop_type="paddy", affected_area_acres=3.0, damage_extent_percent=75.0,
    )
    outside = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "crop", GALNEWA, SUBMITTED_AT, district=ANURADHAPURA,
        replace=True,
        crop_type="paddy", affected_area_acres=40.0, damage_extent_percent=75.0,
    )
    assert inside["feature_values"]["area_outside_trained_range"] is False
    assert outside["feature_values"]["area_outside_trained_range"] is True


@real_crop_model
def test_an_unseen_ds_division_degrades_instead_of_raising(store):
    """ගල්නැව, where every demo household sits, is absent from the synthetic file's 48 Latin-script
    divisions. Geography carries ~2% of the model's importance against area's 81%, so an unseen
    division must cost accuracy, never the estimate."""
    result = compensation.estimate_and_store(
        RealFakeCursor(store), 1, "crop", GALNEWA, SUBMITTED_AT, district=ANURADHAPURA, **CROP_ARGS,
    )
    assert result is not None and result["amount_lkr"] > 0


@real_crop_model
def test_the_artifact_declares_its_synthetic_provenance(store):
    """The warning has to live in the artifact, not only in the training script, because the
    artifact is what production loads and what an examiner would inspect."""
    meta = compensation._load_crop_model()["meta"]
    assert meta["model_version"] == "synthetic_crop_compensation_v1"
    assert meta["synthetic_data"] is True
    assert meta["official_source_verified"] is False
    assert meta["data_status"] == "SYNTHETIC"
    assert "synthetic" in meta["warning"].lower()
    # Outcome columns would let the model see the claim's result. They must not be features.
    assert "claims_approved" not in meta["features"]
    assert "claims_rejected" not in meta["features"]


@real_crop_model
def test_the_two_models_are_separate_artifacts():
    """They must never be merged: rf_compensation_v2 carries a published benchmark, and refitting
    it to share an encoder with synthetic rows would invalidate that number."""
    assert compensation.MODEL_PATH != compensation.CROP_MODEL_PATH
    assert compensation.is_model_available() and compensation.is_crop_model_available()
    assert compensation._load_model() is not compensation._load_crop_model()
