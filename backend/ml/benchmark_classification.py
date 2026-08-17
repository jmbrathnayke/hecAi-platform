"""MobileNetV2 vs ResNet-50 classification benchmark (Story 7.3, AC4 / RER-6, FR-2.6).

Evaluates BOTH models on the IDENTICAL held-out image split and compares accuracy, per-class
P/R/F1, confusion matrix, parameter count, on-disk size and single-image inference latency.

Writes: results/classification_benchmark.json

REQUIRES TENSORFLOW -> ML venv only (Python 3.12). The backend venv is Python 3.14, for which
no TensorFlow wheel exists; that is precisely why TF is pinned in ml/requirements-ml.txt and
never in backend/requirements.txt, which Render installs.

    C:/hecml/.venv/Scripts/python.exe backend/ml/benchmark_classification.py

TWO PREPROCESSING CONTRACTS, and mixing them up is the classic failure here: the deployed
MobileNetV2 expects inputs scaled to [0,1]; ResNet-50 carries its own preprocessing layer and
expects raw [0,255]. Feeding either the other's range degrades accuracy silently instead of
raising, which would quietly corrupt the comparison the dissertation rests on.
"""
import json
import time
from pathlib import Path

import numpy as np

from _config import (CLS_ARTIFACTS, IMAGE_DATASET, IMG_SIZE, MOBILENET_KERAS, RESNET_KERAS,
                     SEED, TFJS_MODEL_DIR, VALIDATION_SPLIT, ensure_results_dir, require)


def load_holdout_images(tf):
    """The same split as training (identical seed) -> identical held-out images.

    SEED / VALIDATION_SPLIT / IMG_SIZE are pinned in _config.py to train_damage_model.py's
    values. Changing any of them changes which images are held out and silently invalidates
    comparison against every previously published figure.
    """
    require(IMAGE_DATASET, "labelled image dataset")
    val_ds = tf.keras.utils.image_dataset_from_directory(
        IMAGE_DATASET, validation_split=VALIDATION_SPLIT, subset="validation", seed=SEED,
        image_size=IMG_SIZE, batch_size=16, label_mode="categorical",
    )
    class_names = val_ds.class_names
    imgs, labels = [], []
    for bx, by in val_ds:
        imgs.append(bx.numpy())
        labels.append(by.numpy())
    return np.concatenate(imgs), np.argmax(np.concatenate(labels), axis=1), class_names


def evaluate(model, images, y_true, class_names) -> dict:
    from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                                 f1_score)
    y_pred = np.argmax(model.predict(images, batch_size=16, verbose=0), axis=1)
    # labels= is not optional. Without it sklearn infers the label set from the data, so a class
    # absent from this split makes target_names the wrong length (ValueError on scikit-learn
    # 1.9.0) and, worse, silently returns a 2x2 confusion_matrix for a 3-class problem -- which
    # would be serialized straight into RER-2's evidence under a 3-class heading. It also keeps
    # the matrices for the two models strictly comparable, which is the whole point of this file.
    _labels = list(range(len(class_names)))
    report = classification_report(y_true, y_pred, labels=_labels, target_names=class_names,
                                   output_dict=True, zero_division=0)
    return {
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
    }


def time_inference(model, sample, n=30) -> float:
    """Mean single-image inference time in ms (CPU), after a 3-call warmup.

    Warmup is not optional: the first call pays graph-tracing and kernel-selection costs that
    would otherwise land entirely on MobileNetV2 and flatter ResNet-50 by comparison.
    """
    x = sample[None].astype("float32")
    for _ in range(3):
        model(x, training=False)
    t0 = time.perf_counter()
    for _ in range(n):
        model(x, training=False)
    return (time.perf_counter() - t0) / n * 1000.0


def dir_size_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    return sum(f.stat().st_size for f in path.glob("*") if f.is_file()) / 1e6


def main() -> None:
    try:
        import tensorflow as tf
    except ImportError:
        raise SystemExit(
            "TensorFlow is required for the classification benchmark and is not installed.\n"
            "The backend venv is Python 3.14, which has no TensorFlow wheel -- this script is\n"
            "meant to run in the ML venv (Python 3.12):\n"
            "    C:/hecml/.venv/Scripts/python.exe backend/ml/benchmark_classification.py\n"
            "Set it up with: pip install -r backend/ml/requirements-ml.txt"
        )

    require(MOBILENET_KERAS, "deployed MobileNetV2 checkpoint")
    require(RESNET_KERAS, "ResNet-50 baseline checkpoint")

    images, y_true, class_names = load_holdout_images(tf)
    print(f"Held-out images: {len(images)}  classes: {class_names}")

    mnv2 = tf.keras.models.load_model(MOBILENET_KERAS)
    resnet = tf.keras.models.load_model(RESNET_KERAS)

    models = {}
    # Deployed MobileNetV2: expects [0,1].
    models["mobilenetv2"] = evaluate(mnv2, images / 255.0, y_true, class_names)
    models["mobilenetv2"].update({
        "params": int(mnv2.count_params()),
        "deployed_size_mb": round(dir_size_mb(TFJS_MODEL_DIR), 2),
        "keras_file_mb": round(MOBILENET_KERAS.stat().st_size / 1e6, 2),
        "inference_ms_per_image": round(time_inference(mnv2, images[0] / 255.0), 2),
    })
    # ResNet-50 baseline: preprocessing is inside the model, so it expects raw [0,255].
    models["resnet50"] = evaluate(resnet, images.astype("float32"), y_true, class_names)
    models["resnet50"].update({
        "params": int(resnet.count_params()),
        "deployed_size_mb": None,  # never shipped to the browser -- far too heavy
        "keras_file_mb": round(RESNET_KERAS.stat().st_size / 1e6, 2),
        "inference_ms_per_image": round(
            time_inference(resnet, images[0].astype("float32")), 2),
    })

    out = {
        "classes": class_names,
        "split": ("80/20 train/validation, seed=123. NO separate test partition exists and "
                  "model selection used this same split, so these are validation metrics and "
                  "are optimistically biased -- equally for both models, so the COMPARISON "
                  "remains fair even though the absolute figures are optimistic."),
        "n_val": int(len(images)),
        # RER-6 asks for BROWSER inference latency. `inference_ms_per_image` below is a
        # Python/TensorFlow desktop-CPU timing -- a different runtime and kernel library, and it
        # understates the gap badly: Python says MobileNetV2 is ~1.9x faster than ResNet-50, a
        # real browser says 10.4x. Keep this field (it is the like-for-like Python comparison)
        # but do not cite it for RER-6.
        "inference_ms_per_image_scope": (
            "Python/TensorFlow on desktop CPU -- NOT browser latency. For RER-6 cite "
            "results/browser_latency.json, produced by frontend/scripts/tfjs-bench/run-bench.mjs."),
        "source_artifacts": {
            "mobilenetv2": str(MOBILENET_KERAS),
            "resnet50": str(RESNET_KERAS),
            "training_pipeline": str(CLS_ARTIFACTS.parent),
        },
        "models": models,
    }
    path = ensure_results_dir() / "classification_benchmark.json"
    # allow_nan=False: json.dumps writes a bare NaN token, which is invalid JSON that Python
    # round-trips happily and every other parser rejects. These files are dissertation evidence,
    # so a degenerate run must fail here rather than commit an unparseable artifact.
    path.write_text(json.dumps(out, indent=2, allow_nan=False), encoding="utf-8")

    print(f"Wrote {path}")
    for name, m in models.items():
        print(f"  {name:14s} acc={m['accuracy']:.3f}  macroF1={m['macro_f1']:.3f}  "
              f"params={m['params']:,}  keras={m['keras_file_mb']}MB  "
              f"infer={m['inference_ms_per_image']}ms/img")


if __name__ == "__main__":
    main()
