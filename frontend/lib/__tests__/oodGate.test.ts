import {
  FEATURE_DIM,
  FEATURE_NODE,
  OUTPUT_NODE,
  OOD_CALIBRATION,
  OOD_THRESHOLD,
  isOutOfDomain,
  nearestPrototypeDistance,
} from "@/lib/oodGate";
import gate from "@/public/models/mobilenetv2/ood_gate.json";
import classNames from "@/public/models/mobilenetv2/class_names.json";
import graph from "@/public/models/mobilenetv2/model.json";

// The gate is a threshold on a distance, so the artifact IS the behaviour: a prototype that is not
// unit-norm, or a threshold copied from a different calibration run, changes every classification
// in the field without changing a line of code. These assertions treat ood_gate.json as code.
describe("ood_gate.json (the calibrated artifact)", () => {
  it("carries the declared number of prototypes per model class", () => {
    // Several prototypes per class, not one: property_damage is a visually diverse class and a
    // single mean sits between its modes, which inflates the in-domain tail and forces the
    // threshold up. See scripts/ood/CALIBRATION.md for the measurement behind the count.
    expect(gate.class_names).toEqual(classNames);
    expect(gate.prototypes).toHaveLength(classNames.length * gate.prototypes_per_class);
    expect(gate.prototype_class).toHaveLength(gate.prototypes.length);
    for (const c of gate.prototype_class) expect(classNames).toContain(c);
  });

  it("stores prototypes at the model's feature width, L2-normalised", () => {
    for (const proto of gate.prototypes) {
      expect(proto).toHaveLength(FEATURE_DIM);
      const norm = Math.sqrt(proto.reduce((a: number, v: number) => a + v * v, 0));
      // Rounded to 6dp in the artifact, so exact 1.0 is not expected.
      expect(norm).toBeCloseTo(1, 4);
    }
  });

  it("names nodes that actually exist in the deployed graph", () => {
    // The gate reads these by name at runtime. A model re-export that renames them would silently
    // fall back to an ungated classification, which is the defect this whole module exists to
    // prevent — so it is asserted here as well as in scripts/ood/extract-embeddings.mjs.
    const names = new Set(graph.modelTopology.node.map((n: { name: string }) => n.name));
    expect(names.has(FEATURE_NODE)).toBe(true);
    expect(names.has(OUTPUT_NODE)).toBe(true);
  });

  it("sets the threshold inside the in-domain distribution it was calibrated from", () => {
    expect(OOD_THRESHOLD).toBeGreaterThan(OOD_CALIBRATION.in_domain_p95);
    expect(OOD_THRESHOLD).toBeLessThanOrEqual(OOD_CALIBRATION.in_domain_max);
    // A gate that rejects a large share of genuine damage photographs is worse than no gate: the
    // officer stops believing it and clicks past every warning. The chosen operating point costs
    // ~2.5%; this guards against a recalibration quietly moving it into annoying territory, not
    // against the current setting.
    expect(OOD_CALIBRATION.false_reject_rate).toBeLessThanOrEqual(0.03);
  });
});

describe("nearestPrototypeDistance", () => {
  const prototype = Float32Array.from(gate.prototypes[0]);

  it("is ~0 for features pointing exactly at a prototype", () => {
    expect(nearestPrototypeDistance(prototype)).toBeCloseTo(0, 4);
  });

  it("ignores magnitude — only the direction of the features matters", () => {
    const scaled = prototype.map((v) => v * 37);
    expect(nearestPrototypeDistance(scaled)).toBeCloseTo(
      nearestPrototypeDistance(prototype) as number,
      5,
    );
  });

  it("exceeds the threshold for features pointing away from every prototype", () => {
    // The features are a post-ReLU global average pool, so every prototype coordinate is >= 0.
    // A negated vector therefore has negative cosine against all three — distance above 1, well
    // past any threshold calibrated inside the in-domain distribution.
    const opposite = prototype.map((v) => -v);
    const d = nearestPrototypeDistance(opposite) as number;
    expect(d).toBeGreaterThan(1);
    expect(isOutOfDomain(d)).toBe(true);
  });

  it("returns null rather than a distance when the features cannot be scored", () => {
    expect(nearestPrototypeDistance(new Float32Array(10))).toBeNull(); // wrong width
    expect(nearestPrototypeDistance(new Float32Array(FEATURE_DIM))).toBeNull(); // all zero
    const withNaN = Float32Array.from(prototype);
    withNaN[0] = NaN;
    expect(nearestPrototypeDistance(withNaN)).toBeNull();
  });
});

describe("isOutOfDomain", () => {
  it("treats a null distance as NOT out of domain — 'the gate could not run' is not a rejection", () => {
    // classifyImage reports that case as gateApplied: false. Conflating it with a pass here would
    // hide a broken gate; conflating it with a rejection would refuse every photo.
    expect(isOutOfDomain(null)).toBe(false);
  });

  it("rejects strictly above the threshold", () => {
    expect(isOutOfDomain(OOD_THRESHOLD)).toBe(false);
    expect(isOutOfDomain(OOD_THRESHOLD + 1e-6)).toBe(true);
    expect(isOutOfDomain(OOD_THRESHOLD - 1e-6)).toBe(false);
  });
});
