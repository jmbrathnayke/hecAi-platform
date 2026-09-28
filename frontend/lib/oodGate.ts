// Open-set (out-of-domain) gate for the on-device damage classifier — Story 3.3 follow-up.
//
// THE DEFECT THIS EXISTS TO FIX. MobileNetV2 here is a CLOSED-SET classifier: its last layer is a
// softmax over exactly three classes, so the three scores always sum to 1 and every input is
// assigned to one of them. Photograph something the model has no concept for — a person's face —
// and it still returns a class, and can return it confidently: 94% property damage, observed in
// the officer UI.
//
// WHY "no_damage" WAS NOT ALREADY THE ANSWER. It looks as though the third class should absorb
// this, and in the compensation workflow it is the right OUTCOME (a no_damage case is never
// priced — compensation.py::_map_damage_category returns None for it, so no estimate is made).
// But the class cannot produce that outcome on its own, because of what it was trained on:
// download_no_damage.py's Wikimedia queries are "paddy field", "rice field", "banana plantation",
// "rural house village", "coconut plantation", ... So `no_damage` means "a field or a house with
// no damage visible" — an intact scene of the same kind — and NOT "this is not a damage
// photograph". A face is not an intact field, so nothing pulls it towards that class.
//
// THE FIX. Read the model's own penultimate features and ask a separate question — "has this
// model ever seen anything like this?" — before trusting the class. The features are the 1280-d
// global average pool that feeds the single dense layer, so this measures distance in exactly the
// space the model's decision is linear in. Each class is summarised by several unit-norm
// prototypes (spherical k-means over its training embeddings), and an image's score is the
// smallest cosine distance to any prototype of any class. Several rather than one because
// property_damage is 277 images of collapsed roofs, broken walls and trampled fences: a single
// mean sits between those modes, which stretches the in-domain distance tail, which forces the
// threshold up — and that was exactly what let a face through. Measured at a fixed 2.5%
// false-rejection budget, one prototype per class catches 77% of face probes and four catch 87%.
// Past the calibrated threshold the class is discarded and the result is recorded as no_damage,
// which is the correct compensation outcome AND the honest one — with the reason kept beside it,
// so "an intact field" and "not a damage photograph at all" stay distinguishable in the record.
//
// CALIBRATION IS ONE-CLASS. The threshold is a percentile of the in-domain score distribution,
// measured leave-one-out (scripts/ood/calibrate.py), so it is fixed by the false-rejection rate
// we accept on real photographs and does not depend on which out-of-domain images were on hand.
// Out-of-domain probes measure the gate; they do not set it. See scripts/ood/README.md for the
// measured numbers, including the max-softmax baseline that this replaces.
//
// Statically imported, exactly like class_names.json and severity_mapping.json, so the gate is
// bundled into the precached chunks and works offline — the whole classification path must.

import gate from "@/public/models/mobilenetv2/ood_gate.json";

/** Identifies the gate in the research log, separately from the classifier's own model_version
 *  (which is unchanged: the weights are byte-identical, only the serving path gained a check). */
export const OOD_GATE_VERSION = "ncm-cosine-v1";

/** The graph node whose output the gate reads. Asserted present by scripts/ood/extract-embeddings.mjs
 *  and by scripts/tfjs-bench/verify-model.mjs --smoke, so a re-export that renames it fails a check
 *  rather than silently disabling the gate. */
export const FEATURE_NODE: string = gate.feature_node;

/** The softmax node, read in the SAME graph execution as the features. Reading the class
 *  probabilities with a second `predict()` call would run the whole network twice and double the
 *  capture-to-result time the officer waits for (Story 3.3 AC4). */
export const OUTPUT_NODE: string = gate.output_node;

export const FEATURE_DIM: number = gate.dim;

/** Cosine distance above which the class is discarded. See the calibration block in ood_gate.json. */
export const OOD_THRESHOLD: number = gate.threshold;

// Float32Array rather than number[]: the dot products below run on every classification, and the
// prototypes are read-only for the lifetime of the page.
const PROTOTYPES: Float32Array[] = (gate.prototypes as number[][]).map((p) => Float32Array.from(p));

/**
 * Smallest cosine distance (1 − cosine similarity, so 0 = identical direction) from these
 * features to any class prototype. Pure, so the decision rule is unit-testable without a model.
 *
 * Returns null when the features cannot be scored — wrong width, or a zero/non-finite vector.
 * Null means "the gate could not run", which the caller must not confuse with "in domain":
 * classifyImage reports it as gateApplied: false rather than as a pass.
 */
export function nearestPrototypeDistance(features: ArrayLike<number>): number | null {
  if (features.length !== FEATURE_DIM) return null;

  let norm = 0;
  for (let i = 0; i < features.length; i++) {
    const v = features[i];
    if (!Number.isFinite(v)) return null;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null; // an all-zero embedding carries no direction to compare

  let best = Infinity;
  for (const proto of PROTOTYPES) {
    let dot = 0;
    for (let i = 0; i < proto.length; i++) dot += proto[i] * features[i];
    // The prototypes are stored already L2-normalised, so dividing by |features| alone completes
    // the cosine. Clamped because rounding can push a perfect match a hair past 1.
    const cos = Math.min(1, Math.max(-1, dot / norm));
    const dist = 1 - cos;
    if (dist < best) best = dist;
  }
  return best;
}

/** Whether a distance from nearestPrototypeDistance() falls outside every trained class. */
export function isOutOfDomain(distance: number | null): boolean {
  return distance !== null && distance > OOD_THRESHOLD;
}

/** The calibration record, surfaced on the research harness page (/model-demo) and quoted in the
 *  dissertation's limitations section rather than being re-derived from memory. */
export const OOD_CALIBRATION = gate.calibration;
