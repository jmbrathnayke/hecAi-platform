# Research ML pipeline (Story 7.3)

Reproducible benchmark and evaluation scripts backing the dissertation's RER-2, RER-3 and RER-6
claims, plus the model bundle the API actually serves.

## Two virtualenvs — this is the important part

| | Python | Installs | Runs |
|---|---|---|---|
| **backend venv** (`backend/venv`) | 3.14.0 | `backend/requirements.txt` | the Flask API, `pytest`, `evaluate.py --task compensation`, `benchmark_compensation.py` |
| **ML venv** (`C:/hecml/.venv`) | 3.12.10 | `backend/ml/requirements-ml.txt` | anything touching TensorFlow: `benchmark_classification.py`, `evaluate.py --task classification` |

**Never add TensorFlow to `backend/requirements.txt`.** Render deploys with
`PYTHON_VERSION 3.14.0` and installs that file; TensorFlow publishes no cp314 wheel, so the
deploy would fail at install time. `scikit-learn` and `pandas` are pinned identically in both
environments, which is why the compensation scripts run in either.

## Scripts

| Script | Venv | Output |
|---|---|---|
| `benchmark_compensation.py` | either | `results/compensation_benchmark.json` — two-stage RF vs two-stage GBM (RER-6) |
| `benchmark_classification.py` | ML only | `results/classification_benchmark.json` — MobileNetV2 vs ResNet-50 (RER-6, FR-2.6) |
| `evaluate.py` | either (skips classification without TF) | `results/compensation_metrics.json` (RER-3), `results/classification_metrics.json` (RER-2) |

```bash
# from backend/ml/
../venv/Scripts/python.exe benchmark_compensation.py
../venv/Scripts/python.exe evaluate.py --task compensation
C:/hecml/.venv/Scripts/python.exe benchmark_classification.py
C:/hecml/.venv/Scripts/python.exe evaluate.py --task classification
```

`benchmark_*` scripts **retrain** candidate architectures to compare them. `evaluate.py`
**does not retrain** — it evaluates the artifacts actually serving production, which is why its
numbers are the ones to cite for deployed behaviour.

## `live_verify_research_export.py` — outstanding

Proves Story 7.3's `/api/v1/research/export` SQL against a **real** Postgres, inside a
transaction that is always rolled back (nothing is committed). It checks the things a fake-DB
test structurally cannot: that `_RESEARCH_SELECT` is valid against the live schema, that
`NUMERIC`/`TIMESTAMPTZ` serialize as expected through a real driver, that two inference rows
written in the *same* transaction (identical `created_at`) both survive the export, that a
missing estimate stays `null` rather than `0.0`, and that a planted `OFFICER-SECRET-123` /
free-text `override_reason` never reach the payload.

**It has not yet been run successfully.** The dev Neon compute refused connections during the
2026-08-09 implementation session (TLS handshake times out on both IPv4 and IPv6). Run it once
the compute is awake — this is the check that caught a real defect in Story 7.2.

```bash
backend/venv/Scripts/python.exe backend/ml/live_verify_research_export.py
```

**Three defects were fixed in this script by the 2026-08-16 code review** — it had never been
run end to end, so none of them had surfaced. Worth knowing before you trust its output:

- It resolved its import path from the **cwd**, not from the file, so the invocation documented
  immediately above raised `ModuleNotFoundError`. Now anchored to `Path(__file__)`.
- It read the export with a fixed `LIMIT 1000` against an **ascending** query, so the rows it
  had just planted (highest ids) fell outside the window once `inference_log` grew past 1000.
  That failed dangerously rather than loudly: `mine` came back empty and the PII check greps
  `repr(mine)`, so every PII assertion would have printed `present=False` and **passed without
  inspecting a single row**. It now sizes the limit from the live count and aborts explicitly if
  the planted rows are not found.
- It printed Sinhala district names before the PII check, and Windows stdout defaults to cp1252
  — on a redirected run it died with `UnicodeEncodeError` at check L and never reached the PII
  block at all. Now reconfigures stdout to UTF-8 first.

## Export cap semantics — the truncated export keeps the OLDEST rows

`/api/v1/research/export` caps at `RESEARCH_MAX_ROWS = 50_000` and orders `ORDER BY il.id`
**ascending**, so once `inference_log` outgrows the cap the export returns the *earliest* 50k
inference rows, not the most recent. This is deliberate and is the opposite of `/admin/export`
(`admin.py`, DESC), which shows an admin the latest activity.

The reason is reproducibility: a research corpus that returns the same rows on every run is
citable, whereas a DESC cap silently changes the dataset underneath a published figure every
time a new inference lands. Ratified 2026-08-16.

Two consequences to respect when quoting numbers from a capped export:

- **Recent model behaviour is invisible at the cap.** If you need current-period metrics after
  the corpus exceeds 50k rows, filter server-side rather than raising the cap.
- **Check the headers, not the row count.** `X-HEC-Truncated` is derived from the delivered
  payload; `X-HEC-Row-Count` is what you actually received. The audit row's `matched_count`
  records how many rows existed at authorisation time and can legitimately differ from both.

## Data locations

Datasets and Keras checkpoints are **not** in this repo (473 images; a 95 MB ResNet-50
checkpoint). They resolve from `HEC_ML_DATA_DIR`, defaulting to
`<repo>/../docs/Human Elephant Conflict Datasets/`:

```
model_training/dataset/{crop_damage,no_damage,property_damage}/   labelled images
model_training/artifacts/inference_model.keras                    deployed MobileNetV2
model_training/artifacts/resnet50/best_model.keras                ResNet-50 baseline
compensation_model/data/compensation_long.csv                     flattened DWC series
```

What **is** committed: these scripts, `models/rf_compensation_v2.joblib` (the serving bundle),
and every JSON in `results/`. Those result files are dissertation evidence — they are
deliberately version-controlled, not gitignored.

## Model facts worth knowing before you touch anything

- **3 classes**, alphabetical: `[crop_damage, no_damage, property_damage]`. Confusion matrices
  are 3×3. (An earlier `false_report` class was removed in the 2026-06-26 data cleanup.)
- **Preprocessing differs per model.** MobileNetV2 expects `[0,1]`; ResNet-50 carries its own
  preprocessing layer and expects raw `[0,255]`. Mixing them degrades accuracy silently rather
  than raising.
- **`rf_compensation_v2.joblib` is `{clf, reg, meta}`**, a two-stage hurdle model — not a bare
  estimator. Prediction is `clf` gate × `expm1(reg.predict(X))`. Omitting the `expm1` inverse
  yields log-scale predictions and an MAE that looks ~5 orders of magnitude too good.
- **The compensation feature set has no `severity` and no crop type** — the real DWC data has
  neither. The 7 real features are in `_config.FEATURES`.
- **`SEED = 123`, `VALIDATION_SPLIT = 0.2`, `IMG_SIZE = (224, 224)`** are pinned to
  `train_damage_model.py`. Changing any of them changes which images are held out and silently
  invalidates comparison against published figures.

## Split caveat — read before quoting the classification numbers

`train_damage_model.py` uses an **80/20 train/validation split with no third test partition**,
and model selection (best-checkpoint) used that same split. The classification figures are
therefore **validation** metrics and are optimistically biased. The JSON field is named `n_val`,
not `n_test`, deliberately — do not relabel it.

The bias applies equally to both models, so the MobileNetV2-vs-ResNet-50 *comparison* stays
fair; it is the absolute figures that are optimistic.

The compensation side is unaffected: it uses a genuine time-based holdout (train 2010–2019,
test 2020–2021, n=359), and the 2020–2021 payout regime shift is itself a reported finding.

## Reproduction status (2026-08-09)

Re-running these scripts reproduced the previously published figures:

| Metric | Published | Reproduced |
|---|---|---|
| MobileNetV2 accuracy / macro-F1 | 0.947 / 0.928 | 0.947 / 0.928 |
| ResNet-50 accuracy / macro-F1 | 0.926 / 0.891 | 0.926 / 0.891 |
| Two-stage RF (time split) MAE / R² | 338,260 / 0.569 | 338,260 / 0.569 |
| Two-stage GBM (time split) MAE / R² | 358,248 / 0.565 | 358,248 / 0.565 |

Inference latency is the one figure that does **not** reproduce exactly (705 ms/img here vs
385 ms published for MobileNetV2) — it is CPU- and load-dependent. The ratio between the two
models is preserved (~1.9× in both runs), which is the comparative claim RER-6 actually makes.
