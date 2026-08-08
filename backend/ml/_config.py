"""Shared path/config resolution for the research ML scripts (Story 7.3).

Why the datasets are not in this repo: the image corpus (473 labelled photos), the Keras
checkpoints (`best_model.keras` 21.9 MB, ResNet-50's 95.1 MB) and the compensation CSV live
under the research working directory, not under version control. What IS committed here is
everything needed to *reproduce and audit* the numbers: the scripts, the serving model bundle
(`models/rf_compensation_v2.joblib`), and the result JSONs in `results/`.

Point `HEC_ML_DATA_DIR` at the dataset root to run any of these scripts elsewhere.
"""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
MODELS_DIR = HERE / "models"

# repo root -> its parent -> the research working directory
_DEFAULT_DATA_DIR = HERE.parent.parent.parent / "docs" / "Human Elephant Conflict Datasets"

DATA_DIR = Path(os.getenv("HEC_ML_DATA_DIR", _DEFAULT_DATA_DIR))

# --- classification -----------------------------------------------------------------------
IMAGE_DATASET = DATA_DIR / "model_training" / "dataset"
CLS_ARTIFACTS = DATA_DIR / "model_training" / "artifacts"
MOBILENET_KERAS = CLS_ARTIFACTS / "inference_model.keras"   # deployed; expects [0,1]
RESNET_KERAS = CLS_ARTIFACTS / "resnet50" / "best_model.keras"  # baseline; expects [0,255]
TFJS_MODEL_DIR = HERE.parent.parent / "frontend" / "public" / "models" / "mobilenetv2"

# Must match train_damage_model.py exactly. Changing any of these changes WHICH images are held
# out, silently invalidating every comparison against the published figures.
SEED = 123
IMG_SIZE = (224, 224)
VALIDATION_SPLIT = 0.2

# --- compensation -------------------------------------------------------------------------
COMPENSATION_CSV = DATA_DIR / "compensation_model" / "data" / "compensation_long.csv"
RF_BUNDLE = MODELS_DIR / "rf_compensation_v2.joblib"

CAT_ONEHOT = ["damage_type"]
CAT_ORDINAL = ["district", "ds_division"]
NUMERIC = ["year", "prior_year_amount", "prior_year_incident_count", "prior_year_had_payout"]
FEATURES = CAT_ONEHOT + CAT_ORDINAL + NUMERIC
TARGET = "amount_lkr"
TEST_YEARS = {2020, 2021}
RANDOM_STATE = 42


def ensure_results_dir() -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    return RESULTS_DIR


def require(path: Path, what: str) -> Path:
    if not path.exists():
        raise SystemExit(
            f"Missing {what}: {path}\n"
            f"These assets are not committed to the repo. Set HEC_ML_DATA_DIR to the dataset "
            f"root (currently: {DATA_DIR})."
        )
    return path
