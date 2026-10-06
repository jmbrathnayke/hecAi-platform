"""Server-side RF compensation estimation (Story 5.2, FR-4.1/FR-4.2/FR-4.4/FR-4.5).

Plain module-level functions, no class -- mirrors infrastructure/audit.py's
write_audit_log(cur, ...) shape. Called inline from cases.py::submit_case,
sync.py::_sync_one and officer_cases.py, in the SAME transaction as the case
write, so a case and its estimate are always consistent. Never raises out to the
caller -- estimation is a best-effort enhancement, not a requirement of a
successful submit/sync.

district/ai_severity are optional. A caller that has neither gets
"unknown"/neutral-multiplier behavior. Citizen self-service cases never have
ai_severity (no AI classification step on that tree) but may have district (the
Story 5.2 picker).
"""
import json
import logging
import os
from typing import Any

import joblib
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "ml", "models")
MODEL_PATH = os.path.join(_MODELS_DIR, "rf_compensation_v2.joblib")
CROP_MODEL_PATH = os.path.join(_MODELS_DIR, "synthetic_crop_compensation_v1.joblib")
LOOKUP_PATH = os.path.join(_MODELS_DIR, "compensation_prior_year_lookup.json")
DISTRICT_REF_PATH = os.path.join(_MODELS_DIR, "district_reference.json")

FEATURES = ["damage_type", "district", "ds_division", "year",
            "prior_year_amount", "prior_year_incident_count", "prior_year_had_payout"]

CROP_FEATURES = ["crop_type", "severity", "district", "ds_division", "year",
                 "affected_area_acres", "damage_extent_percent"]

# The five crops the crop model was fit on. Whitelisted here rather than trusted from the request:
# an unrecognised value must skip crop estimation, never reach predict() and be silently encoded as
# an unknown category that still produces a confident number.
CROP_TYPES = ("bada_irigu", "banana", "coconut", "paddy", "vegetable")

# Story 5.2 Open Question 1 (PO recommendation, shipped): the historical DWC dataset behind
# rf_compensation_v2 has damage_type in {death, injury, property} and no crop class at all, so
# every incident-form category maps onto its best-covered "property" category. "none" (no damage)
# intentionally has no entry -> estimation is skipped (a false report isn't a claim).
#
# `crop_damage` is the classifier's own class id, which reaches this function from the officer
# assessment path while the citizen form sends `crop`. Both vocabularies are already present in
# cases.damage_category; before this entry existed the classifier spelling fell through to None and
# 5 of the 8 such cases in the database carry no estimate at all -- a silent skip, not an error.
_DAMAGE_TYPE_MAP = {"crop": "property", "crop_damage": "property",
                    "property": "property", "property_damage": "property",
                    "combined": "property",
                    "death": "death", "human_death": "death",
                    "injury": "injury", "human_injury": "injury"}

# Which categories route to the crop model instead, when a crop type is supplied. Falls back to the
# property model when it is not, so an officer who does not know the crop still gets the previous
# behaviour rather than nothing.
_CROP_CATEGORIES = frozenset({"crop", "crop_damage"})

# Untrained, post-hoc adjustment (PO-ratified scope addition) -- the RF bundle was never
# fit on severity (the historical DWC dataset has no severity column), so this multiplies
# the RF's raw output rather than being fed into predict(). The explicit string "None"
# (an active AI reading of "no visible damage") and Python None (no classification ran at
# all, e.g. every citizen self-service case) are kept as distinct dict semantics even
# though both currently resolve to the same neutral multiplier.
_SEVERITY_MULTIPLIER = {"Minor": 0.7, "Moderate": 1.0, "Severe": 1.3, "None": 1.0}

_bundle: dict[str, Any] | str | None = None
_crop_bundle: dict[str, Any] | str | None = None
_prior_year_lookup: dict[str, Any] | None = None
_district_reference: dict[str, Any] | None = None


def _load_model():
    global _bundle
    if _bundle is None:
        try:
            _bundle = joblib.load(MODEL_PATH)
        except Exception:
            # Broad on purpose (not just FileNotFoundError/OSError): a corrupted or
            # version-incompatible joblib file can raise several exception types
            # (pickle errors, ValueError, EOFError...) and this must degrade the same
            # way regardless -- estimation becomes unavailable, never a crash.
            logger.exception("RF compensation model failed to load from %s", MODEL_PATH)
            _bundle = "unavailable"
    return _bundle


def _load_crop_model():
    """Same contract as _load_model(): absent or broken means unavailable, never an exception.

    A deployment without this artifact keeps working exactly as it did before the crop model
    existed -- crop reports fall back to the property path. That fallback is what makes adding a
    second model safe to deploy independently of the first.
    """
    global _crop_bundle
    if _crop_bundle is None:
        try:
            _crop_bundle = joblib.load(CROP_MODEL_PATH)
        except Exception:
            logger.info("Crop compensation model not loaded from %s; crop reports will use the "
                        "property model", CROP_MODEL_PATH)
            _crop_bundle = "unavailable"
    return _crop_bundle


def is_model_available() -> bool:
    bundle = _load_model()
    return bundle != "unavailable" and bundle is not None


def is_crop_model_available() -> bool:
    bundle = _load_crop_model()
    return bundle != "unavailable" and bundle is not None


def _load_lookup():
    global _prior_year_lookup, _district_reference
    if _prior_year_lookup is None:
        try:
            with open(LOOKUP_PATH, encoding="utf-8") as f:
                _prior_year_lookup = json.load(f)
        except (FileNotFoundError, OSError, ValueError):
            _prior_year_lookup = {}
    if _district_reference is None:
        try:
            with open(DISTRICT_REF_PATH, encoding="utf-8") as f:
                _district_reference = json.load(f)
        except (FileNotFoundError, OSError, ValueError):
            _district_reference = {}
    return _prior_year_lookup, _district_reference


def _map_damage_category(damage_category):
    return _DAMAGE_TYPE_MAP.get(damage_category)


def _resolve_district(district, ds_division_id):
    """`district` is the picker's direct output (Story 5.2 Task 7) -- if the caller
    already has it, use it as-is, no lookup needed. Otherwise fall back to deriving it
    from ds_division_id (pre-picker queued drafts), and finally to the "unknown"
    sentinel the model's OrdinalEncoder(handle_unknown=...) degrades gracefully on."""
    if district:
        return district, ds_division_id or district
    _, district_ref = _load_lookup()
    if ds_division_id and ds_division_id in district_ref:
        return district_ref[ds_division_id], ds_division_id
    return "unknown", "unknown"


def _prior_year_features(district, ds_division, damage_type, raw_damage_type=None):
    lookup, _ = _load_lookup()
    lookup_type = raw_damage_type or damage_type
    key = f"{district}|{ds_division}|{lookup_type}"
    entry = lookup.get(key)
    if entry:
        return entry
    if lookup_type != damage_type:
        fallback_key = f"{district}|{ds_division}|{damage_type}"
        entry = lookup.get(fallback_key)
        if entry:
            return entry
    return {"prior_year_amount": 0.0, "prior_year_incident_count": -1.0,
            "prior_year_had_payout": 0.0}


def _severity_multiplier(ai_severity):
    return _SEVERITY_MULTIPLIER.get(ai_severity, 1.0)  # absent/unrecognized -> neutral


def compute_estimate(bundle, damage_type, district, ds_division, year, ai_severity, cap, raw_damage_type=None):
    """The whole serving transform, with no I/O of its own -- pure given `bundle` and `cap`.

    Extracted from estimate_and_store so the dissertation evaluation can score THIS code
    rather than a re-implementation of it (backend/ml/evaluate.py, RER-3). Scoring a
    hand-copied version of the transform would measure the copy, not the deployed path --
    the same "test that cannot fail" failure mode this project keeps hitting.

    `cap` is the policy ceiling in LKR or None for "no cap enforced"; the caller owns
    fetching it, because that is the one step here that needs a database.
    """
    prior = _prior_year_features(district, ds_division, damage_type, raw_damage_type=raw_damage_type)
    row = {
        "damage_type": damage_type, "district": district, "ds_division": ds_division,
        "year": year, **prior,
    }
    X = pd.DataFrame([row], columns=FEATURES)

    gate = bool(bundle["clf"].predict(X)[0])
    model_raw = float(np.clip(np.expm1(bundle["reg"].predict(X)[0]), 0, None)) if gate else 0.0
    multiplier = _severity_multiplier(ai_severity)
    raw_estimate = model_raw * multiplier

    capped = cap is not None and raw_estimate > cap
    return {
        "amount": cap if capped else raw_estimate,
        "raw_estimate": raw_estimate,
        "model_raw": model_raw,
        "multiplier": multiplier,
        "capped": capped,
        "row": row,
    }


def compute_crop_estimate(bundle, crop_type, district, ds_division, year, severity,
                          affected_area_acres, damage_extent_percent, cap):
    """The crop serving transform. Pure given `bundle` and `cap`, exactly like compute_estimate().

    Kept pure for the same reason: backend/ml/evaluate.py must be able to score THIS code rather
    than a re-implementation of it. Two models with one honest evaluation path, not two.

    NO SEVERITY MULTIPLIER HERE, and that is the substantive difference from the property path.
    rf_compensation_v2 was never fit on severity -- the historical dataset has no such column -- so
    compute_estimate() multiplies the model's output afterwards by a hand-chosen 0.7/1.0/1.3. The
    crop model WAS fit on severity as a one-hot feature, using the same Minor/Moderate/Severe
    vocabulary resolveSeverity() emits, so the classifier's reading enters through predict() and
    multiplying again would double-count it.

    An unseen district or DS division is encoded as -1 by the OrdinalEncoder rather than raising:
    the synthetic file's 48 Latin-script divisions only partly overlap the platform's Sinhala ones,
    and geography carries ~2% of the model's importance against area's 81%, so a miss degrades the
    estimate slightly instead of losing it.
    """
    row = {
        "crop_type": crop_type,
        "severity": severity if severity in ("Minor", "Moderate", "Severe") else "Moderate",
        "district": district,
        "ds_division": ds_division,
        "year": year,
        "affected_area_acres": float(affected_area_acres),
        "damage_extent_percent": float(damage_extent_percent),
    }
    X = pd.DataFrame([row], columns=CROP_FEATURES)

    gate = bool(bundle["clf"].predict(X)[0])
    raw_estimate = float(np.clip(np.expm1(bundle["reg"].predict(X)[0]), 0, None)) if gate else 0.0

    capped = cap is not None and raw_estimate > cap
    return {
        "amount": cap if capped else raw_estimate,
        "raw_estimate": raw_estimate,
        "model_raw": raw_estimate,
        "multiplier": 1.0,
        "capped": capped,
        "row": row,
    }


# The area range the synthetic file actually covers (0.1 – 3.5 acres). A random forest cannot
# extrapolate: beyond the largest leaf it has, it simply repeats that leaf's value, so a 40-acre
# claim would return the 3.5-acre answer while looking like a prediction. Inputs past this are
# accepted — refusing a real assessment because the training data was narrow would be worse — but
# flagged, so the estimate is never read as if the model had seen anything like it.
CROP_AREA_TRAINED_MAX = 3.5
CROP_AREA_ABSOLUTE_MAX = 100.0


def _crop_inputs(crop_type, affected_area_acres, damage_extent_percent):
    """-> (crop_type, acres, percent) when all three are usable, else None.

    Validated here, server-side, rather than trusted from the officer's request. `crop_type` is
    whitelisted against the five values the model was fit on; a typo or an unseen crop must fall
    back to the property path, not be one-hot encoded as "no known crop" and still priced.

    The numeric bounds catch typing slips rather than enforce policy: `affected_area_acres` carries
    81% of the model's importance, so a mistyped 250 for 2.5 would otherwise produce a confident
    six-figure estimate. Anything inside the bounds but outside the TRAINED range is allowed through
    and marked — see CROP_AREA_TRAINED_MAX.
    """
    if crop_type not in CROP_TYPES:
        return None
    try:
        acres = float(affected_area_acres)
        percent = float(damage_extent_percent)
    except (TypeError, ValueError):
        return None
    if not (0 < acres <= CROP_AREA_ABSOLUTE_MAX) or not (0 < percent <= 100):
        return None
    return crop_type, acres, percent


def estimate_and_store(cur, case_id, damage_category, ds_division_id, submitted_at,
                        district=None, ai_severity=None, replace=False,
                        crop_type=None, affected_area_acres=None, damage_extent_percent=None):
    """Best-effort: returns the stored dict on success, None on any skip/failure.
    Never raises -- a bug here must not fail the case insert/sync it's
    piggybacking on. `district`/`ds_division_id`/`ai_severity` are string-or-None;
    an empty string is treated the same as absent.

    `replace=True` regenerates the estimate for a case that already has one (the officer's
    on-device assessment supplies an ai_severity the citizen submission could not). The row is
    replaced rather than appended because compensation_estimates is UNIQUE on case_id (migration
    013) and every reader expects at most one current estimate; the superseded figure survives in
    the caller's audit event. Same model, same features -- only the severity input changes."""
    district = district or None
    ds_division_id = ds_division_id or None
    ai_severity = ai_severity or None

    damage_type = _map_damage_category(damage_category)
    if damage_type is None:
        return None  # "none" (no damage) or an unrecognized category -> no claim to estimate

    # Route. A crop report priced by the crop model needs all three officer-supplied inputs and the
    # artifact present; anything missing falls back to the property path, which is what every crop
    # report used before this model existed. The fallback is deliberate -- a partially filled
    # assessment should degrade to the previous behaviour, never to no estimate at all.
    crop = _crop_inputs(crop_type, affected_area_acres, damage_extent_percent)
    use_crop = (damage_category in _CROP_CATEGORIES and crop is not None
                and is_crop_model_available())

    if not use_crop and not is_model_available():
        logger.warning("Compensation model unavailable; skipping estimate for case %s", case_id)
        return None

    # Isolate this function's own SQL in a SAVEPOINT. `cur` is the CALLER's cursor,
    # shared with the case INSERT + audit-log write already committed earlier in the
    # same transaction -- a bare Python try/except here catches the exception, but a
    # psycopg2.Error from one of THIS function's own queries still leaves the shared
    # connection's transaction in Postgres's "aborted" state. The caller's enclosing
    # `with conn:` block then calls commit() on exit (no exception propagated to it),
    # and PostgreSQL silently treats COMMIT-on-aborted as a ROLLBACK -- discarding the
    # case row and audit log too, with the API still reporting success. The SAVEPOINT
    # confines a failure to just this function's own work.
    try:
        cur.execute("SAVEPOINT compensation_estimate")
    except Exception:
        logger.exception("Could not open savepoint for case %s; skipping estimate", case_id)
        return None

    try:
        bundle = _load_crop_model() if use_crop else _load_model()
        if not isinstance(bundle, dict):
            return None
        resolved_district, ds_division = _resolve_district(district, ds_division_id)

        # Fetched before the prediction (it used to follow it) only because compute_estimate
        # takes the cap as an argument -- it is the one step of the transform that needs a
        # database, so it stays here rather than inside the pure function. Both SELECTs still
        # precede the INSERT, so the statement order Postgres sees is unchanged.
        # The crop branch prices against a "crop" ceiling rather than the property one. Both keys
        # are absent from compensation_caps today (the table holds no rows at all), so cap is None
        # either way and nothing is capped -- but the key must be the right one for the day the
        # policy ceilings are loaded.
        cap_damage_type = "crop" if use_crop else damage_type
        cur.execute(
            "SELECT cap_amount_lkr FROM compensation_caps WHERE district = %s AND damage_type = %s",
            (resolved_district, cap_damage_type),
        )
        cap_row = cur.fetchone()
        cap = float(cap_row[0]) if cap_row else None

        if use_crop:
            crop_name, acres, percent = crop
            est = compute_crop_estimate(bundle, crop_name, resolved_district, ds_division,
                                        submitted_at.year, ai_severity, acres, percent, cap)
        else:
            est = compute_estimate(bundle, damage_type, resolved_district, ds_division,
                                   submitted_at.year, ai_severity, cap,
                                   raw_damage_type=damage_category)

        meta = bundle["meta"]
        if use_crop:
            model_version = meta.get("model_version", "synthetic_crop_compensation_v1")
            dataset_version = meta.get("dataset_version")
        else:
            model_version = f"rf_compensation_{meta.get('version', 'v2')}"
            dataset_version = meta.get("dataset")

        # Provenance stored WITH every estimate, not only in the training artifact, so that anyone
        # reading a row back -- the admin UI, the DS panel, the research export, an examiner
        # querying the database directly -- can tell which model priced it and on what data,
        # without having to know which model_version strings mean "synthetic".
        #
        # `decision_support_only` and `is_final_decision` are invariants of this system rather than
        # per-row facts: no estimate this function produces is ever a final compensation decision,
        # which the DS officer alone makes. They are written into every row anyway, because a
        # constant that is only asserted in documentation stops being checkable the moment someone
        # reads the table without the documentation.
        provenance = {
            "model_version": model_version,
            "synthetic_model": bool(use_crop and meta.get("synthetic_data", True)),
            "decision_support_only": True,
            "is_final_decision": False,
        }
        if use_crop:
            provenance["data_status"] = meta.get("data_status", "SYNTHETIC")
            # Recorded rather than rejected: the estimate stands, but a reader can see that the
            # model was asked about a field larger than anything in its training data.
            provenance["area_outside_trained_range"] = crop[1] > CROP_AREA_TRAINED_MAX

        result = {
            "amount_lkr": round(est["amount"], 2),
            "raw_estimate_lkr": round(est["raw_estimate"], 2),
            "capped": est["capped"],
            "feature_values": {**est["row"], "ai_severity": ai_severity,
                               "severity_multiplier": est["multiplier"], **provenance},
            "model_version": model_version,
            "dataset_version": dataset_version,
            "synthetic_model": provenance["synthetic_model"],
            "decision_support_only": True,
            "is_final_decision": False,
        }

        params = (case_id, result["amount_lkr"], result["raw_estimate_lkr"], result["capped"],
                  json.dumps(result["feature_values"]), result["model_version"],
                  result["dataset_version"])
        if replace:
            cur.execute(
                """INSERT INTO compensation_estimates
                     (case_id, amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                      model_version, dataset_version)
                   VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
                   ON CONFLICT (case_id) DO UPDATE
                     SET amount_lkr = EXCLUDED.amount_lkr,
                         raw_estimate_lkr = EXCLUDED.raw_estimate_lkr,
                         capped = EXCLUDED.capped,
                         feature_values_json = EXCLUDED.feature_values_json,
                         model_version = EXCLUDED.model_version,
                         dataset_version = EXCLUDED.dataset_version,
                         created_at = now()""",
                params,
            )
        else:
            cur.execute(
                """INSERT INTO compensation_estimates
                     (case_id, amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                      model_version, dataset_version)
                   VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)""",
                params,
            )
        cur.execute("RELEASE SAVEPOINT compensation_estimate")
        return result
    except Exception:
        logger.exception("Compensation estimation failed for case %s", case_id)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT compensation_estimate")
        except Exception:
            logger.exception(
                "Failed to roll back to savepoint after estimation failure for case %s", case_id
            )
        return None
