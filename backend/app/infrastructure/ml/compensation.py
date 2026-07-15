"""Server-side RF compensation estimation (Story 5.2, FR-4.1/FR-4.2/FR-4.4/FR-4.5).

Plain module-level functions, no class -- mirrors infrastructure/audit.py's
write_audit_log(cur, ...) shape. Called inline from cases.py::submit_case,
sync.py::_sync_one, and sms.py::inbound_sms, in the SAME transaction as the case
insert, so a case and its estimate are always consistent. Never raises out to the
caller -- estimation is a best-effort enhancement, not a requirement of a
successful submit/sync/sms.

district/ai_severity are optional. SMS-originated cases never pass them and get
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
LOOKUP_PATH = os.path.join(_MODELS_DIR, "compensation_prior_year_lookup.json")
DISTRICT_REF_PATH = os.path.join(_MODELS_DIR, "district_reference.json")

FEATURES = ["damage_type", "district", "ds_division", "year",
            "prior_year_amount", "prior_year_incident_count", "prior_year_had_payout"]

# Story 5.2 Open Question 1 (PO recommendation, shipped): the incident form's damage
# category vocabulary has no separate crop line item and no death/injury path at all --
# every value maps onto the model's best-covered "property" category. "none" (no damage)
# intentionally has no entry -> estimation is skipped (a false report isn't a claim).
_DAMAGE_TYPE_MAP = {"crop": "property", "property": "property", "combined": "property"}

# Untrained, post-hoc adjustment (PO-ratified scope addition) -- the RF bundle was never
# fit on severity (the historical DWC dataset has no severity column), so this multiplies
# the RF's raw output rather than being fed into predict(). The explicit string "None"
# (an active AI reading of "no visible damage") and Python None (no classification ran at
# all, e.g. every citizen self-service case) are kept as distinct dict semantics even
# though both currently resolve to the same neutral multiplier.
_SEVERITY_MULTIPLIER = {"Minor": 0.7, "Moderate": 1.0, "Severe": 1.3, "None": 1.0}

_bundle: dict[str, Any] | str | None = None
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


def is_model_available() -> bool:
    bundle = _load_model()
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
    from ds_division_id (SMS, pre-picker queued drafts), and finally to the "unknown"
    sentinel the model's OrdinalEncoder(handle_unknown=...) degrades gracefully on."""
    if district:
        return district, ds_division_id or district
    _, district_ref = _load_lookup()
    if ds_division_id and ds_division_id in district_ref:
        return district_ref[ds_division_id], ds_division_id
    return "unknown", "unknown"


def _prior_year_features(district, ds_division, damage_type):
    lookup, _ = _load_lookup()
    key = f"{district}|{ds_division}|{damage_type}"
    entry = lookup.get(key)
    if entry:
        return entry
    return {"prior_year_amount": 0.0, "prior_year_incident_count": -1.0,
            "prior_year_had_payout": 0.0}


def _severity_multiplier(ai_severity):
    return _SEVERITY_MULTIPLIER.get(ai_severity, 1.0)  # absent/unrecognized -> neutral


def estimate_and_store(cur, case_id, damage_category, ds_division_id, submitted_at,
                        district=None, ai_severity=None):
    """Best-effort: returns the stored dict on success, None on any skip/failure.
    Never raises -- a bug here must not fail the case insert/sync/sms it's
    piggybacking on. `district`/`ds_division_id`/`ai_severity` are string-or-None;
    an empty string is treated the same as absent."""
    district = district or None
    ds_division_id = ds_division_id or None
    ai_severity = ai_severity or None

    damage_type = _map_damage_category(damage_category)
    if damage_type is None:
        return None  # "none" (no damage) or an unrecognized category -> no claim to estimate

    if not is_model_available():
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
        bundle = _load_model()
        if not isinstance(bundle, dict):
            return None
        resolved_district, ds_division = _resolve_district(district, ds_division_id)
        year = submitted_at.year
        prior = _prior_year_features(resolved_district, ds_division, damage_type)

        row = {
            "damage_type": damage_type, "district": resolved_district, "ds_division": ds_division,
            "year": year, **prior,
        }
        X = pd.DataFrame([row], columns=FEATURES)

        gate = bool(bundle["clf"].predict(X)[0])
        model_raw = float(np.clip(np.expm1(bundle["reg"].predict(X)[0]), 0, None)) if gate else 0.0
        multiplier = _severity_multiplier(ai_severity)
        raw_estimate = model_raw * multiplier

        cur.execute(
            "SELECT cap_amount_lkr FROM compensation_caps WHERE district = %s AND damage_type = %s",
            (resolved_district, damage_type),
        )
        cap_row = cur.fetchone()
        cap = float(cap_row[0]) if cap_row else None
        capped = cap is not None and raw_estimate > cap
        amount = cap if capped else raw_estimate

        meta = bundle["meta"]
        result = {
            "amount_lkr": round(amount, 2),
            "raw_estimate_lkr": round(raw_estimate, 2),
            "capped": capped,
            "feature_values": {**row, "ai_severity": ai_severity, "severity_multiplier": multiplier},
            "model_version": f"rf_compensation_{meta.get('version', 'v2')}",
            "dataset_version": meta.get("dataset"),
        }

        cur.execute(
            """INSERT INTO compensation_estimates
                 (case_id, amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                  model_version, dataset_version)
               VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)""",
            (case_id, result["amount_lkr"], result["raw_estimate_lkr"], result["capped"],
             json.dumps(result["feature_values"]), result["model_version"],
             result["dataset_version"]),
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
