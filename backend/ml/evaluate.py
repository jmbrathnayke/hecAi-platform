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
import json

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from _config import (FEATURES, RF_BUNDLE, TARGET, TEST_YEARS, ensure_results_dir, require)
from benchmark_compensation import load, predict_two_stage


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
    }
    path = ensure_results_dir() / "compensation_metrics.json"
    # allow_nan=False -- see the note in evaluate_classification(). r2_score returns nan on a
    # zero-variance holdout, which is exactly the degenerate case that must not reach the file.
    path.write_text(json.dumps(metrics, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Wrote {path}")
    print(f"  MAE={metrics['mae']:,.0f}  RMSE={metrics['rmse']:,.0f}  R2={metrics['r2']:.3f}  "
          f"n_test={metrics['n_test']}")
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
