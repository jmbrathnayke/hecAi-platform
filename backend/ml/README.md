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
| `frontend/scripts/tfjs-bench/run-bench.mjs` | node | `results/browser_latency.json` — **browser** inference latency (RER-6) |
| `frontend/scripts/tfjs-bench/verify-model.mjs` | node | no file; asserts the deployed TF.js model actually loads and predicts |

```bash
# from backend/ml/
../venv/Scripts/python.exe benchmark_compensation.py
../venv/Scripts/python.exe evaluate.py --task compensation      # ~20 min: the serving-path
                                                                # block calls the shipped
                                                                # compute_estimate() once per
                                                                # row per severity (4 x 359
                                                                # single-row RF predicts).
                                                                # Slow on purpose — it scores
                                                                # the deployed code, not a copy.
C:/hecml/.venv/Scripts/python.exe benchmark_classification.py
C:/hecml/.venv/Scripts/python.exe evaluate.py --task classification

# from frontend/ — browser latency, and the guard that the model loads at all
node scripts/tfjs-bench/verify-model.mjs --smoke
node scripts/tfjs-bench/run-bench.mjs --resnet <dir with the ResNet TF.js export>
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

## Browser latency (RER-6) — 2026-08-17, supersedes the Python figures

RER-6 asks for **"browser inference latency"**. `inference_ms_per_image` in
`classification_benchmark.json` is a Python/TensorFlow desktop-CPU timing: a different runtime, a
different kernel library, a different numeric path. It is not a proxy for what a device does, and
the two disagree by more than a factor of five on the comparative claim. **Cite
`browser_latency.json` for RER-6 latency; cite `classification_benchmark.json` for accuracy.**

Steady-state `predict()` + `.data()`, median of the timed samples, warm-up and cold start excluded:

| Model | webgl | cpu | model load | on-disk |
|---|---|---|---|---|
| MobileNetV2 | **751.5 ms** | 3,870.9 ms | 559 ms | 9.02 MB |
| ResNet-50 | **7,831.7 ms** | 32,136.9 ms | 7,693 ms | 94.08 MB |
| **ratio** | **10.4×** | 8.3× | 13.8× | 10.4× |

The Python benchmark put the gap at 1.9×. In a browser it is **10.4×** — the comparative claim is
far stronger than the desktop numbers suggested, and it is the one RER-6 actually asks for.

Read the `caveats` array in the JSON before quoting anything. The two that matter most: headless
Chromium renders WebGL through **SwiftShader (software)**, so these are not GPU timings — a real
GPU improves the webgl rows and leaves the cpu rows alone; and this is desktop hardware, not a field
device. The **ratio** is the defensible claim, not the absolute milliseconds. The ResNet rows hit
the per-configuration time budget (`hit_time_budget: true`, n=16 and n=4 rather than 30) — with a
median that far apart, more samples would not change the conclusion.

ResNet-50 is deliberately **not** committed as a TF.js model: at 94 MB it would be swept into the
service-worker precache and shipped to every field device. Convert it to a scratch directory and
pass `--resnet`. Without the flag the harness benchmarks MobileNetV2 alone and records that it did.

## Compensation: the model figure is not the system figure (RER-3)

`compensation_metrics.json` now carries two things. The **top-level** `mae`/`rmse`/`r2` score
`predict_two_stage` — the model — and are unchanged from first publication. The **`serving_path`**
block scores the same held-out rows through `app/infrastructure/ml/compensation.py`'s
`compute_estimate()`, which is what the API actually runs.

| | MAE | R² |
|---|---|---|
| model (`predict_two_stage`) | 338,260 | 0.569 |
| **deployed serving path** | **556,473** | **−0.277** |
| reference: always predict the test mean | 547,945 | 0.000 |

Two divergences cause it, and **only in combination** — alone they give R² 0.446 and 0.555:

1. `_DAMAGE_TYPE_MAP` collapses every incident-form category to `"property"`. The form has no crop
   line item and no death/injury path at all, so the deployed system cannot ask the model about a
   death claim — yet 52% of the held-out rows are death or injury.
2. `_prior_year_features` reads a year-less snapshot lookup that is **itself keyed on damage_type**,
   so collapsing the type also makes the lookup return the property row's payout history.

Split by the claim's true type, the failure is entirely outside the design's reach: **property
R² 0.406** (n=173), death −2.745, injury −50.435. The policy cap is currently **inert** —
`compensation_caps` has 0 rows, so `capped` is false for every prediction, and the severity
multiplier defaults to the neutral 1.0 for historical rows (the 0.7/1.3 band is reported as
`severity_sensitivity_mae`).

`evaluate.py` imports the serving module **by file path** rather than as
`app.infrastructure.ml.compensation`, because the package import would pull in Flask and this script
must stay runnable in the ML venv. That still scores the shipped file, which is the point —
re-implementing the transform here would measure the re-implementation.

### Declared scope: property damage (decided 2026-08-17)

Death and injury are **out of scope** — no labelled image corpus exists for either, so the
classifier has no such class, and the incident form has no pathway, meaning the system cannot accept
such a claim at all. The `property_scope` block in `compensation_metrics.json` carries the figures
to cite for RER-3:

| property test rows, n=173 | MAE | R² |
|---|---|---|
| **model** (true per-year lags) | 417,061 | **0.601** |
| **deployed serving path** | 406,134 | **0.406** |
| reference: always predict the property mean | 736,222 | 0.000 |

**Do not retrain on property rows alone** — it was measured and it does not help: R² 0.596 vs 0.601
on true lags, and 0.360 vs 0.406 through the serving path. The death and injury rows still teach the
model regional payout structure across 3,960 rows rather than 1,233. **Narrow the claim, keep the
training set.** RF still beats GBM under the narrowed scope (0.596 vs 0.549), so RER-6 holds. The
`retraining_verdict` field records this so nobody re-derives it.

Note on thresholds: the ≥ 0.65 R² and ≤ 25%-of-mean MAE targets that appear in older documents are
**pre-revision**, written for per-incident records. The PRD revised them on 2026-07-03 (`prd.md:71`)
to ≥ 0.60 random / ≥ 0.55 time-based once it was established that DWC data exists only as
division-year aggregates. Measured MAE is ~61% of the test mean and cannot reach 25% with aggregate
data.

Which number to publish is a write-up decision; see the F2 section of
`_bmad-output/implementation-artifacts/deferred-work-triage-2026-08-17.md`.

## The deployed model must be verified in a real browser, not just converted

`export_tfjs.py` used to emit a **tfjs layers model from a Keras 3 checkpoint**. That conversion
exits 0 and produces a `model.json` that **no browser can load** — tfjs-layers 4.22.0 cannot
deserialize Keras 3's layers format (`batch_shape` vs `batch_input_shape` on InputLayer, and
`inbound_nodes` as an object rather than an array). On-device classification was broken in
production and no test caught it, because every frontend test mocks `@tensorflow/tfjs` wholesale
and never loads a real weight file.

The model is now a **graph model** (`tf.loadGraphModel`), which is the supported Keras 3 path.
Before shipping any re-export:

```bash
cd hec-platform/frontend
node scripts/tfjs-bench/verify-model.mjs --smoke     # loads the real model in a real browser
```

`--smoke` needs no dataset, so CI can run it. For the stronger numerical check, generate fixtures
(real validation images plus the Keras model's own probabilities) and pass `--fixtures`; that
asserts the browser reproduces Keras to within 1e-3. The current export was verified this way:
**argmax 8/8, max |Δp| 2e-6**.
