"""Dissertation metric files for the SHIPPED models (Story 7.3, AC6 / RER-2, RER-3).

Distinct from the two benchmark scripts: those retrain candidate architectures to compare them,
this one evaluates the artifacts actually serving production and emits the two metric files the
evaluation chapter cites.

Writes:
  results/compensation_metrics.json   - MAE / RMSE / R2 for models/rf_compensation_v2.joblib
  results/classification_metrics.json - per-class P/R/F1 + confusion matrix for the deployed
                                        MobileNetV2  (requires TensorFlow -- ML venv only)

    python backend/ml/evaluate.py                    # both, skipping what it cannot run
    python backend/ml/evaluate.py --task compensation
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from _config import (FEATURES, RF_BUNDLE, TARGET, TEST_YEARS, ensure_results_dir, require)
from benchmark_compensation import load, predict_two_stage

_SERVING_MODULE = (Path(__file__).resolve().parent.parent
                   / "app" / "infrastructure" / "ml" / "compensation.py")


def evaluate_compensation() -> dict:
    """Evaluates the exact bundle the API serves, on the held-out 2020-2021 rows.

    Loads models/rf_compensation_v2.joblib rather than retraining, so these numbers describe
    what the deployed system actually does. The bundle is {clf, reg, meta} -- a two-stage
    hurdle model -- NOT a bare estimator; see app/infrastructure/ml/compensation.py for the
    matching serving-side unpack.
    """
    require(RF_BUNDLE, "compensation model bundle")
    bundle = joblib.load(RF_BUNDLE)
    if not isinstance(bundle, dict) or {"clf", "reg", "meta"} - set(bundle):
        raise SystemExit(
            f"Unexpected bundle shape in {RF_BUNDLE}: expected keys {{clf, reg, meta}}, "
            f"got {sorted(bundle) if isinstance(bundle, dict) else type(bundle).__name__}"
        )
    meta = bundle["meta"]

    df = load()
    test = df[df["year"].isin(TEST_YEARS)]
    X_te, y_te = test[FEATURES], test[TARGET].values
    preds = predict_two_stage(bundle["clf"], bundle["reg"], X_te)

    metrics = {
        "model": f"rf_compensation_{meta.get('version', 'v2')}",
        "architecture": meta.get("architecture"),
        "trained_on": meta.get("trained_on"),
        "dataset": meta.get("dataset"),
        "split": "time-based holdout: test = 2020-2021 (never seen in training)",
        "n_test": int(len(test)),
        "test_mean_lkr": float(y_te.mean()),
        "mae": float(mean_absolute_error(y_te, preds)),
        "rmse": float(np.sqrt(mean_squared_error(y_te, preds))),
        "r2": float(r2_score(y_te, preds)),
        "features": meta.get("features", FEATURES),
        # These top-level figures score predict_two_stage -- the MODEL. They are kept exactly as
        # first published (nothing already cited moves) but they are not what the API returns:
        # the serving path adds a damage-type collapse, a snapshot feature lookup, a severity
        # multiplier and a policy cap. `serving_path` below measures that. Cite whichever answers
        # the question being asked, but do not present the model figure as system behaviour.
        "scope": "model only (predict_two_stage) -- see serving_path for deployed behaviour",
        "serving_path": evaluate_compensation_serving(),
    }
    path = ensure_results_dir() / "compensation_metrics.json"
    # allow_nan=False -- see the note in evaluate_classification(). r2_score returns nan on a
    # zero-variance holdout, which is exactly the degenerate case that must not reach the file.
    path.write_text(json.dumps(metrics, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Wrote {path}")
    print(f"  model  MAE={metrics['mae']:,.0f}  RMSE={metrics['rmse']:,.0f}  "
          f"R2={metrics['r2']:.3f}  n_test={metrics['n_test']}")
    sp = metrics["serving_path"]
    print(f"  served MAE={sp['mae']:,.0f}  RMSE={sp['rmse']:,.0f}  R2={sp['r2']:.3f}  "
          f"(capped={sp['n_predictions_capped']}, zero-prior fallbacks="
          f"{sp['n_rows_falling_back_to_zero_priors']})")
    return metrics


def _load_serving_module():
    """Load the shipped serving module BY FILE PATH, not as `app.infrastructure.ml.compensation`.

    The package import would execute `app/__init__.py`, which imports Flask -- and this script is
    documented to run in the ML venv too, where Flask is not installed. Loading the file directly
    keeps the property that actually matters (these numbers describe the DEPLOYED code, not a
    re-implementation of it) without dragging the web framework into the ML environment.
    `compensation.py` has no relative imports, so it loads standalone.
    """
    require(_SERVING_MODULE, "serving compensation module")
    spec = importlib.util.spec_from_file_location("_hec_serving_compensation", _SERVING_MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fetch_caps() -> tuple[dict, str]:
    """-> ({(district, damage_type): cap_lkr}, description of where they came from).

    The policy cap is the one part of the serving transform that needs a database. Reading it is
    OPTIONAL on purpose: this script must stay runnable in either venv with no DB, so an absent
    DATABASE_URL yields "no caps enforced" -- which is also what migration 014 ships (it seeds no
    rows, and an absent row means no cap). Which of the two happened is recorded in the output,
    because "no caps applied" for want of a connection and "no caps applied" because none are
    configured are very different claims to publish.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        return {}, "DATABASE_URL unset - scored with no cap enforced (migration 014 seeds none)"
    try:
        import psycopg2
    except ImportError:
        return {}, "psycopg2 unavailable in this venv - scored with no cap enforced"
    try:
        conn = psycopg2.connect(url, connect_timeout=30)
    except Exception as exc:  # unreachable DB must not fail the metric run
        return {}, f"database unreachable ({type(exc).__name__}) - scored with no cap enforced"
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT district, damage_type, cap_amount_lkr FROM compensation_caps")
            caps = {(d, t): float(c) for d, t, c in cur.fetchall()}
    finally:
        conn.rollback()
        conn.close()
    return caps, f"read from compensation_caps ({len(caps)} row(s) configured)"


def _regression_metrics(y_true, y_pred) -> dict:
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "r2": float(r2_score(y_true, y_pred)),
    }


def _divergence_decomposition(serving, bundle, test, y_true) -> dict:
    """Attribute the model-vs-served gap to its two causes, and to their interaction.

    Without this the headline is just "the served number is much worse", which invites the
    wrong fix. The decomposition shows neither divergence is harmful ALONE -- it is the
    interaction that collapses the fit, because the prior-year lookup is itself keyed on
    damage_type: collapsing the type to "property" does not merely change the model's type
    feature, it also makes the lookup return the PROPERTY row's history for a death claim.
    """
    def frame(collapse_type, snapshot_priors):
        rows = []
        for r in test.itertuples():
            damage_type = "property" if collapse_type else r.damage_type
            if snapshot_priors:
                priors = serving._prior_year_features(r.district, r.ds_division, damage_type)
            else:
                priors = {"prior_year_amount": r.prior_year_amount,
                          "prior_year_incident_count": r.prior_year_incident_count,
                          "prior_year_had_payout": r.prior_year_had_payout}
            rows.append({"damage_type": damage_type, "district": r.district,
                         "ds_division": r.ds_division, "year": r.year, **priors})
        return pd.DataFrame(rows, columns=FEATURES)

    def run(collapse_type, snapshot_priors):
        preds = predict_two_stage(bundle["clf"], bundle["reg"], frame(collapse_type, snapshot_priors))
        return _regression_metrics(y_true, preds)

    return {
        "_note": "isolates each serving-side divergence; D reproduces the served figures above",
        "A_true_type_true_lags__published_model": run(False, False),
        "B_true_type_snapshot_lookup": run(False, True),
        "C_collapsed_type_true_lags": run(True, False),
        "D_collapsed_type_snapshot_lookup__deployed": run(True, True),
        "reference_always_predict_test_mean": _regression_metrics(
            y_true, np.full(len(y_true), float(np.mean(y_true)))),
    }


def evaluate_compensation_serving() -> dict:
    """Score the held-out rows through the ACTUAL serving transform (RER-3, review decision 3).

    evaluate_compensation() above scores `predict_two_stage` -- the bare model. That is not what
    the API returns. app/infrastructure/ml/compensation.py::estimate_and_store applies four more
    steps before a number reaches a case file, and this function runs the shipped code for all
    of them by calling compute_estimate() directly:

      1. `_DAMAGE_TYPE_MAP` collapses EVERY incident-form category to "property". The form has no
         crop line item and no death/injury path at all (Story 5.2 Open Question 1), so the
         deployed system literally cannot ask the model about a death or an injury claim -- yet
         52% of the held-out rows are exactly that. This is the dominant divergence, and it is
         invisible in the bare-model figure.
      2. `_prior_year_features` reads a year-less snapshot lookup keyed district|division|type,
         where the offline evaluation derives true per-year lags from the CSV. Rows with no
         matching key fall back to zeros -- silently.
      3. `_severity_multiplier` scales the output by 0.7/1.0/1.3. Historical rows carry no
         severity, so the neutral 1.0 is the honest default; the sensitivity band is reported
         separately rather than being folded into a single headline number.
      4. The `compensation_caps` policy ceiling truncates the high tail -- when any caps exist.

    Reported alongside the bare-model figures, never replacing them: the comparison IS the finding.
    """
    serving = _load_serving_module()
    require(RF_BUNDLE, "compensation model bundle")
    bundle = joblib.load(RF_BUNDLE)
    caps, cap_source = _fetch_caps()

    df = load()
    test = df[df["year"].isin(TEST_YEARS)]
    y_true = test[TARGET].values

    # Every non-"none" form category maps to the same model vocabulary entry, so which one we
    # feed is immaterial -- that collapse is the point being measured.
    served_type = serving._map_damage_category("property")

    def run(ai_severity):
        amounts, capped_n, lookup_miss = [], 0, 0
        for row in test.itertuples():
            est = serving.compute_estimate(
                bundle, served_type, row.district, row.ds_division, row.year,
                ai_severity, caps.get((row.district, served_type)))
            amounts.append(est["amount"])
            capped_n += bool(est["capped"])
            if est["row"]["prior_year_incident_count"] == -1.0 and \
                    est["row"]["prior_year_amount"] == 0.0:
                lookup_miss += 1
        return np.array(amounts), capped_n, lookup_miss

    preds, n_capped, n_lookup_miss = run(None)

    per_type = {
        t: {**_regression_metrics(y_true[mask], preds[mask]), "n": int(mask.sum()),
            "true_mean_lkr": float(y_true[mask].mean())}
        for t in sorted(test["damage_type"].unique())
        for mask in [(test["damage_type"] == t).values]
    }

    metrics = {
        "scored_through": "app/infrastructure/ml/compensation.py::compute_estimate (shipped code)",
        "split": "time-based holdout: test = 2020-2021 (never seen in training)",
        "n_test": int(len(test)),
        "ai_severity_assumed": None,
        "severity_multiplier_applied": serving._severity_multiplier(None),
        "cap_source": cap_source,
        "n_predictions_capped": int(n_capped),
        "n_rows_falling_back_to_zero_priors": int(n_lookup_miss),
        "damage_type_sent_to_model": served_type,
        "damage_type_collapse": (
            "_DAMAGE_TYPE_MAP maps crop/property/combined -> 'property'; the incident form has no "
            "death or injury path, so those claims cannot reach the model as themselves"),
        **_regression_metrics(y_true, preds),
        "per_true_damage_type": per_type,
        "severity_sensitivity_mae": {
            s: float(mean_absolute_error(y_true, run(s)[0]))
            for s in ("Minor", "Moderate", "Severe")
        },
        "divergence_decomposition": _divergence_decomposition(serving, bundle, test, y_true),
    }
    return metrics


def evaluate_classification() -> dict | None:
    """Per-class metrics for the deployed MobileNetV2 on the held-out image split.

    NOTE ON THE SPLIT, and it matters for the write-up: train_damage_model.py uses an 80/20
    train/VALIDATION split with no third partition, and model selection (best-checkpoint) used
    that same split. These figures are therefore VALIDATION metrics and are optimistically
    biased -- the field below is named `n_val`, not `n_test`, for exactly that reason. Do not
    relabel it. (The compensation side above is unaffected: it has a genuine time-based holdout.)
    """
    try:
        import tensorflow as tf
    except ImportError:
        print("SKIP classification: TensorFlow unavailable.\n"
              "  This is expected in the backend venv (Python 3.14 -- no TF wheel exists) and\n"
              "  is why TF is pinned in ml/requirements-ml.txt, never backend/requirements.txt.\n"
              "  Run this in the ML venv (Python 3.12) to regenerate classification_metrics.json.")
        return None

    from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                                 f1_score)

    from _config import IMAGE_DATASET, IMG_SIZE, MOBILENET_KERAS, SEED, VALIDATION_SPLIT

    require(IMAGE_DATASET, "labelled image dataset")
    require(MOBILENET_KERAS, "deployed MobileNetV2 checkpoint")

    val_ds = tf.keras.utils.image_dataset_from_directory(
        IMAGE_DATASET, validation_split=VALIDATION_SPLIT, subset="validation", seed=SEED,
        image_size=IMG_SIZE, batch_size=16, label_mode="categorical",
    )
    class_names = val_ds.class_names
    imgs, labels = [], []
    for bx, by in val_ds:
        imgs.append(bx.numpy())
        labels.append(by.numpy())
    images = np.concatenate(imgs)
    y_true = np.argmax(np.concatenate(labels), axis=1)

    model = tf.keras.models.load_model(MOBILENET_KERAS)
    # The deployed model expects [0,1]; feeding raw [0,255] silently degrades accuracy rather
    # than erroring, so this scaling is load-bearing.
    y_pred = np.argmax(model.predict(images / 255.0, batch_size=16, verbose=0), axis=1)

    # labels= is not optional. Without it sklearn infers the label set from the data, so a class
    # absent from this split makes target_names the wrong length (ValueError on scikit-learn
    # 1.9.0) and, worse, silently returns a 2x2 confusion_matrix for a 3-class problem -- which
    # would be serialized straight into RER-2's evidence under a 3-class heading.
    _labels = list(range(len(class_names)))
    report = classification_report(y_true, y_pred, labels=_labels, target_names=class_names,
                                   output_dict=True, zero_division=0)
    metrics = {
        "model": "mobilenetv2",
        "classes": class_names,
        "split": ("80/20 train/validation, seed=123. NO separate test partition exists and "
                  "model selection used this same split, so these are validation metrics and "
                  "are optimistically biased."),
        "n_val": int(len(images)),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macro_f1": float(f1_score(y_true, y_pred, average="macro")),
        "per_class": {
            c: {
                "precision": float(report[c]["precision"]),
                "recall": float(report[c]["recall"]),
                "f1": float(report[c]["f1-score"]),
                "support": int(report[c]["support"]),
            }
            for c in class_names
        },
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=_labels).tolist(),
        "confusion_matrix_axes": {"rows": "true", "cols": "predicted", "order": class_names},
    }
    path = ensure_results_dir() / "classification_metrics.json"
    # allow_nan=False: json.dumps writes a bare NaN token, which is invalid JSON that Python
    # round-trips happily and every other parser rejects. These files are dissertation evidence,
    # so a degenerate run must fail here rather than commit an unparseable artifact.
    path.write_text(json.dumps(metrics, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Wrote {path}")
    print(f"  accuracy={metrics['accuracy']:.3f}  macroF1={metrics['macro_f1']:.3f}  "
          f"n_val={metrics['n_val']}")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", choices=("all", "classification", "compensation"),
                        default="all")
    args = parser.parse_args()

    if args.task in ("all", "compensation"):
        evaluate_compensation()
    if args.task in ("all", "classification"):
        evaluate_classification()


if __name__ == "__main__":
    main()
