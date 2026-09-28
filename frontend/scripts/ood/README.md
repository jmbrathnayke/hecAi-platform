# The open-set gate

## What was wrong

MobileNetV2 as deployed here is a **closed-set** classifier: its last layer is a softmax over
exactly three classes, so the three scores always sum to 1 and every input is assigned to one of
them. There is no "none of these" output for it to return.

The consequence showed up in the officer UI: a photograph of a person's face was classified
**property damage at 94% confidence**. Nothing was broken — the model did the only thing its output
layer permits.

## Why `no_damage` did not already solve it

The natural objection is that the third class should absorb this: anything that is neither crop
damage nor property damage is, by elimination, no damage — and in the compensation workflow that is
exactly the right *outcome*, because `compensation.py::_map_damage_category` returns `None` for a
no-damage case, so no estimate is generated and nothing can be paid.

But the class cannot produce that outcome on its own, because of what it was trained on.
`download_no_damage.py` built it from these Wikimedia Commons queries:

> "paddy field", "rice field", "banana plantation", "vegetable garden farm", "rural house village",
> "village house asia", "farmland landscape", "maize field", "coconut plantation",
> "sri lanka village", "tea plantation field", "green crop field", "house exterior rural",
> "cassava field"

So `no_damage` means **"a field or a house with no damage visible"** — an intact scene of the same
kind the other two classes show damaged. It does not mean "this is not a damage photograph". A face
is not an intact field, so nothing in the learned representation pulls it towards that class.

Retraining `no_damage` into a catch-all is not a fix either: "everything in the world that is not a
damaged field" has no coherent visual definition, and any finite sample of it teaches the model the
sample, not the concept.

## What the gate does

Read the model's own penultimate features and ask a **separate question** — *has this model ever
seen anything like this?* — before trusting the class.

- The features are the 1280-d global average pool (`global_average_pooling2d_1/Mean`) that feeds the
  single dense layer, so distance is measured in exactly the space the model's decision is linear in.
- Each class is summarised by several unit-norm **prototypes** — spherical k-means over its
  training embeddings — and an image's score is the smallest cosine distance to any of them.
  Several rather than one because `property_damage` is 277 images of collapsed roofs, broken walls
  and trampled fences: a single mean sits between those modes, stretches the in-domain distance
  tail, and forces the threshold up. At a fixed 2.5% false-rejection budget, one prototype per
  class catches 76% of the out-of-domain probes and 77% of the faces; four catch 88% and 87%.
- Past the calibrated threshold, the class is discarded and the result is recorded as `no_damage`
  with `out_of_domain: true` beside it — the right compensation outcome, and an honest record,
  because "an intact field" and "nothing recognised" stay distinguishable in `inference_log`.

The officer's Override is untouched: the gate narrows what the model asserts, it does not take the
decision away from the person on site.

### The model is not retrained

`inference_model.keras` and the deployed TF.js weights are byte-identical to before. The gate reads
an existing node of the existing graph. `MODEL_VERSION` is therefore unchanged and the classifier's
reported accuracy still describes the same classifier; the gate carries its own version
(`OOD_GATE_VERSION`) in the research log.

## How it was calibrated

**In a real browser, against the deployed graph.** `extract-embeddings.mjs` launches Chromium,
serves `public/models/mobilenetv2/`, and reads the feature node through the *same*
`blobToImageData()` production uses — `createImageBitmap({resizeQuality:"medium"})` then
`drawImage`, then `/255`. Calibrating on numbers from the Keras model instead would calibrate the
threshold for a *different pipeline*: `predict_image.py` resizes with `tf.image.resize` (bilinear,
no antialiasing) while the browser resizes through `createImageBitmap` and `drawImage`. Those are
different resampling algorithms, so they do not produce the same 224×224 pixels, so they do not
produce the same embeddings — and a distance threshold is only meaningful for the pipeline it was
measured on. Extracting here removes that question rather than leaving it to be argued about.

**One-class, leave-one-out.** `calibrate.py` sets the threshold at a percentile of the *in-domain*
distance distribution, recomputing each training image's own class prototype without it so no image
is ever scored against a mean it helped build. The threshold is therefore fixed by the
false-rejection rate we accept on genuine damage photographs, and does not depend on which
out-of-domain images happened to be available.

**The probes measure, they do not fit.** The out-of-domain set is licensed Wikimedia Commons
photographs (faces, people, animals, vehicles, food, devices, interiors, documents, street scenes)
plus this system's own UI screenshots. `download_ood_probes.py` (session scratchpad) collects them
the same way the training set was collected, with attribution logged.

Measured results: **[CALIBRATION.md](CALIBRATION.md)** — generated by `calibrate.py`, never edited
by hand.

## Running it

```sh
# 1. embeddings (Chromium; ~3.7 s/image on software WebGL — ~47 min for 765; checkpoints per batch)
node scripts/ood/extract-embeddings.mjs \
  --root "crop_damage=<dataset>/crop_damage" \
  --root "no_damage=<dataset>/no_damage" \
  --root "property_damage=<dataset>/property_damage" \
  --root "heldout=../model-test-img" \
  --root "probe=<ood probe folder>" \
  --root "screenshot=../../system-screenshots" \
  --out <work dir>

# 2. threshold + prototypes + CALIBRATION.md
C:/hecml/.venv/Scripts/python.exe scripts/ood/calibrate.py --emb <work dir> \
  --out public/models/mobilenetv2/ood_gate.json
```

`ood_gate.json` is imported statically by `lib/oodGate.ts`, like `class_names.json` and
`severity_mapping.json`, so it is bundled into the precached chunks and the gate works offline —
which the whole classification path must.

## Limits

- The threshold is a single global cutoff. It does not adapt to lighting, camera or season; a
  measured false-rejection rate on 473 training photographs is the only guarantee it carries.
- A photograph that is *visually* close to a field or a wall but is not damage — an undamaged fence,
  a pile of building material — is in-domain by this measure and will still be classified. The gate
  answers "has the model seen this kind of image", not "is this claim genuine".
- The probe set is licensed archive photography, not phone photographs taken in Sri Lanka. It is
  adequate to show that the gate separates obviously-unrelated images; it is not a field trial.
