"""RF vs GBM compensation benchmark (Story 7.3, AC5 / RER-6).

Trains BOTH architectures from scratch on the identical time-based split and compares them:
  - two-stage hurdle Random Forest  (the architecture actually shipped, rf_compensation_v2)
  - two-stage hurdle Gradient Boosting

Writes: results/compensation_benchmark.json

WHY TWO-STAGE. The real DWC data is ~57% zero-payout rows, so a single regressor spends its
capacity predicting zeros. Stage A classifies "was there a payout at all"; Stage B regresses
log1p(amount) on the positive rows only; the prediction is gate x expm1(StageB). Dropping the
expm1 inverse yields log-scale predictions and an MAE that looks ~5 orders of magnitude better
than reality -- the single easiest way to publish a wrong number from this script.

WHY A TIME-BASED SPLIT (train 2010-2019, test 2020-2021) rather than a random one: a random
split leaks future years into training for a series that has a real regime shift (test-period
mean LKR 556k vs 144k overall). Both are reported -- the random split is the optimistic figure,
the time split is the honest one.

Runs in EITHER virtualenv: needs only scikit-learn + pandas + numpy, both already pinned in
backend/requirements.txt. No TensorFlow.

    python backend/ml/benchmark_compensation.py
"""
import json

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import (GradientBoostingClassifier, GradientBoostingRegressor,
                              RandomForestClassifier, RandomForestRegressor)
from sklearn.metrics import f1_score, mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder

from _config import (CAT_ONEHOT, CAT_ORDINAL, COMPENSATION_CSV, FEATURES, NUMERIC,
                     RANDOM_STATE, TARGET, TEST_YEARS, ensure_results_dir, require)


def load() -> pd.DataFrame:
    """Loads the flattened DWC series and derives the three lag features.

    Reads the already-flattened compensation_long.csv, NOT the raw 3-sheet workbook: going back
    to the .xlsx would mean re-implementing build_compensation_dataset.py and would need
    openpyxl, which is not a backend dependency.
    """
    require(COMPENSATION_CSV, "compensation dataset")
    df = pd.read_csv(COMPENSATION_CSV, encoding="utf-8-sig")
    df = df.sort_values(["district", "ds_division", "damage_type", "year"])
    grp = df.groupby(["district", "ds_division", "damage_type"])
    df["prior_year_incident_count"] = grp["incident_count"].shift(1)
    df["prior_year_had_payout"] = (grp["amount_lkr"].shift(1) > 0).astype(float)
    df["prior_year_amount"] = df["prior_year_amount"].fillna(0.0)
    df["prior_year_incident_count"] = df["prior_year_incident_count"].fillna(-1.0)
    return df


def preprocessor() -> ColumnTransformer:
    return ColumnTransformer([
        ("oh", OneHotEncoder(handle_unknown="ignore"), CAT_ONEHOT),
        # handle_unknown/-1 rather than raising: an unseen district must degrade, never 500 the
        # serving path (the same decision recorded for Story 5.2 in deferred-work.md).
        ("ord", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1),
         CAT_ORDINAL),
        ("num", "passthrough", NUMERIC),
    ])


def make_two_stage(kind: str):
    if kind == "rf":
        clf = RandomForestClassifier(n_estimators=400, min_samples_leaf=2,
                                     class_weight="balanced", n_jobs=-1,
                                     random_state=RANDOM_STATE)
        reg = RandomForestRegressor(n_estimators=400, min_samples_leaf=2, n_jobs=-1,
                                    random_state=RANDOM_STATE)
    elif kind == "gbm":
        clf = GradientBoostingClassifier(n_estimators=400, max_depth=3, learning_rate=0.05,
                                         random_state=RANDOM_STATE)
        reg = GradientBoostingRegressor(n_estimators=400, max_depth=3, learning_rate=0.05,
                                        random_state=RANDOM_STATE)
    else:  # pragma: no cover - programmer error
        raise ValueError(f"unknown model kind: {kind}")
    return (Pipeline([("pre", preprocessor()), ("model", clf)]),
            Pipeline([("pre", preprocessor()), ("model", reg)]))


def fit_two_stage(clf, reg, X_tr, y_tr):
    clf.fit(X_tr, (y_tr > 0).astype(int))
    pos = y_tr > 0
    reg.fit(X_tr[pos], np.log1p(y_tr[pos]))


def predict_two_stage(clf, reg, X) -> np.ndarray:
    gate = clf.predict(X).astype(bool)
    # expm1 inverts the log1p target; clip at 0 because a negative payout is meaningless.
    amounts = np.clip(np.expm1(reg.predict(X)), 0, None)
    return np.where(gate, amounts, 0.0)


def metrics(y_true, y_pred, df_test) -> dict:
    pos = y_true > 0
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "r2": float(r2_score(y_true, y_pred)),
        "mae_positive_rows": float(mean_absolute_error(y_true[pos], y_pred[pos])),
        "mae_pct_of_test_mean": float(
            mean_absolute_error(y_true, y_pred) / y_true.mean() * 100),
        "hurdle_f1_payout_detection": float(
            f1_score(pos.astype(int), (y_pred > 0).astype(int))),
        "per_damage_type_mae": {
            t: float(mean_absolute_error(y_true[df_test["damage_type"] == t],
                                         y_pred[df_test["damage_type"] == t]))
            for t in sorted(df_test["damage_type"].unique())
        },
    }


def main() -> None:
    df = load()
    train = df[~df["year"].isin(TEST_YEARS)]
    test = df[df["year"].isin(TEST_YEARS)]
    X_tr, y_tr = train[FEATURES], train[TARGET].values
    X_te, y_te = test[FEATURES], test[TARGET].values

    models = {}
    for kind in ("rf", "gbm"):
        clf, reg = make_two_stage(kind)
        fit_two_stage(clf, reg, X_tr, y_tr)
        models[f"two_stage_{kind}"] = metrics(y_te, predict_two_stage(clf, reg, X_te), test)

    # Random-split RF for contrast: the optimistic number, reported so the gap between it and
    # the time split is visible rather than a choice the reader cannot see.
    Xr_tr, Xr_te, yr_tr, yr_te, _df_tr, df_te = train_test_split(
        df[FEATURES], df[TARGET].values, df, test_size=0.2, random_state=RANDOM_STATE)
    clf, reg = make_two_stage("rf")
    fit_two_stage(clf, reg, Xr_tr, yr_tr)
    models["two_stage_rf_random_split"] = metrics(
        yr_te, predict_two_stage(clf, reg, Xr_te), df_te)
    # This entry is the ONE model here not scored on the time-based holdout, so it carries its
    # own split label and n. Without them a reader pairs these metrics with the file-level
    # "split" and n_test=359 above -- but they were computed on a different, larger sample
    # (20% of all rows, drawn across every year). The contrast is the point; mislabelling it
    # would turn a deliberate disclosure into an accidental overclaim.
    models["two_stage_rf_random_split"]["split"] = (
        f"random 80/20, random_state={RANDOM_STATE} -- NOT the time split; reported for contrast "
        f"as the optimistic figure")
    models["two_stage_rf_random_split"]["n_test"] = int(len(df_te))

    out = {
        # Applies to every model above EXCEPT two_stage_rf_random_split, which carries its own.
        "split": "time-based: train 2010-2019, test 2020-2021",
        "n_train": int(len(train)),
        "n_test": int(len(test)),
        "test_mean_lkr": float(y_te.mean()),
        "zero_share_test": float((y_te == 0).mean()),
        "features": FEATURES,
        "target": TARGET,
        "models": models,
    }
    path = ensure_results_dir() / "compensation_benchmark.json"
    # allow_nan=False: json.dumps writes a bare NaN token, which is invalid JSON that Python
    # round-trips happily and every other parser rejects. r2_score returns nan on a zero-variance
    # holdout -- exactly the degenerate case that must not reach dissertation evidence.
    path.write_text(json.dumps(out, indent=2, allow_nan=False), encoding="utf-8")

    print(f"Wrote {path}")
    for name, m in models.items():
        print(f"  {name:28s} MAE={m['mae']:>12,.0f}  RMSE={m['rmse']:>12,.0f}  "
              f"R2={m['r2']:.3f}  payoutF1={m['hurdle_f1_payout_detection']:.3f}")


if __name__ == "__main__":
    main()
