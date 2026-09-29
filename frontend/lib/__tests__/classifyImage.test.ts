import {
  topClass,
  resolveSeverity,
  classifyImage,
  MODEL_VERSION,
  INPUT_SIZE,
  __resetModelForTests,
} from "@/lib/mobilenet";
import { FEATURE_DIM, OOD_GATE_VERSION, OOD_THRESHOLD } from "@/lib/oodGate";
import gate from "@/public/models/mobilenetv2/ood_gate.json";

// Features pointing exactly at a real prototype (distance ~0 -> in domain), and their negation.
// The features are a post-ReLU pool, so every prototype coordinate is >= 0 and the negated vector
// has a negative cosine against all three: distance above 1, past any calibrated threshold.
const IN_DOMAIN_FEATURES = Float32Array.from(gate.prototypes[0]);
const OUT_OF_DOMAIN_FEATURES = IN_DOMAIN_FEATURES.map((v) => -v);

// Mutable holder so individual tests can steer the model's softmax output and its penultimate
// features, force the tensor read to reject, break the feature node, and observe disposal.
// Prefixed `mock` so jest's out-of-scope-reference guard permits the factory to close over it.
const mockState = {
  probs: new Float32Array([0.1, 0.05, 0.85]) as ArrayLike<number>,
  features: IN_DOMAIN_FEATURES as ArrayLike<number>,
  dataRejects: false,
  executeThrows: false,
  dispose: jest.fn(),
};

jest.mock("@tensorflow/tfjs", () => {
  // A chainable stub for `fromPixels(imageData).toFloat().div(255).expandDims(0)`.
  const chain = {
    toFloat: () => chain,
    div: () => chain,
    expandDims: () => chain,
  };
  const tensor = (read: () => ArrayLike<number>) => ({
    data: () =>
      mockState.dataRejects
        ? Promise.reject(new Error("tensor read failed"))
        : Promise.resolve(read()),
    dispose: mockState.dispose,
  });
  return {
    ready: jest.fn().mockResolvedValue(undefined),
    loadGraphModel: jest.fn().mockResolvedValue({
      // classifyImage asks for [OUTPUT_NODE, FEATURE_NODE] in one graph run.
      execute: () => {
        if (mockState.executeThrows) throw new Error("node not found in graph");
        return [tensor(() => mockState.probs), tensor(() => mockState.features)];
      },
      predict: () => tensor(() => mockState.probs),
    }),
    tidy: (fn: () => unknown) => fn(),
    browser: { fromPixels: () => chain },
  };
});

beforeEach(() => {
  __resetModelForTests();
  mockState.probs = new Float32Array([0.1, 0.05, 0.85]);
  mockState.features = IN_DOMAIN_FEATURES;
  mockState.dataRejects = false;
  mockState.executeThrows = false;
  mockState.dispose.mockClear();

  // jsdom lacks these browser globals; stub them so blobToImageData's OffscreenCanvas path runs.
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = jest
    .fn()
    .mockResolvedValue({ close: jest.fn() });
  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return {
        drawImage: jest.fn(),
        getImageData: () => ({
          data: new Uint8ClampedArray(INPUT_SIZE * INPUT_SIZE * 4),
          width: INPUT_SIZE,
          height: INPUT_SIZE,
        }),
      };
    }
  }
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
});

describe("topClass", () => {
  it("returns the argmax class and its confidence in class_names order", () => {
    // class_names.json order: [crop_damage, no_damage, property_damage]
    expect(topClass([0.7, 0.2, 0.1])).toEqual({ classId: "crop_damage", confidence: 0.7 });
    expect(topClass([0.1, 0.8, 0.1])).toEqual({ classId: "no_damage", confidence: 0.8 });
    expect(topClass([0.05, 0.15, 0.8])).toEqual({ classId: "property_damage", confidence: 0.8 });
  });

  it("keeps the first class on a tie (stable argmax)", () => {
    expect(topClass([0.5, 0.5, 0]).classId).toBe("crop_damage");
  });
});

describe("resolveSeverity (confidence-band rule)", () => {
  it("always maps the no_damage class to None regardless of confidence", () => {
    expect(resolveSeverity("no_damage", 0.99)).toBe("None");
    expect(resolveSeverity("no_damage", 0.1)).toBe("None");
  });

  it("maps a damage class by confidence band", () => {
    expect(resolveSeverity("crop_damage", 0.85)).toBe("Severe"); // >= 0.85
    expect(resolveSeverity("crop_damage", 0.9)).toBe("Severe");
    expect(resolveSeverity("property_damage", 0.65)).toBe("Moderate"); // >= 0.65
    expect(resolveSeverity("property_damage", 0.7)).toBe("Moderate");
    expect(resolveSeverity("crop_damage", 0.64)).toBe("Minor"); // below all higher bands
    expect(resolveSeverity("property_damage", 0.1)).toBe("Minor");
  });
});

describe("classifyImage", () => {
  it("returns the top class, derived severity, confidence, timing, and model version", async () => {
    const result = await classifyImage(new Blob(["x"], { type: "image/jpeg" }));
    expect(result.classId).toBe("property_damage"); // argmax of [0.1, 0.05, 0.85]
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.severity).toBe("Severe");
    expect(result.modelVersion).toBe(MODEL_VERSION);
    expect(typeof result.processingTimeMs).toBe("number");
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("derives a Moderate no-damage-excluded severity from a mid-confidence result", async () => {
    mockState.probs = new Float32Array([0.7, 0.2, 0.1]); // crop_damage @ 0.7
    const result = await classifyImage(new Blob(["x"], { type: "image/jpeg" }));
    expect(result.classId).toBe("crop_damage");
    expect(result.severity).toBe("Moderate");
  });

  it("reports None severity when no_damage wins", async () => {
    mockState.probs = new Float32Array([0.2, 0.75, 0.05]); // no_damage @ 0.75
    const result = await classifyImage(new Blob(["x"], { type: "image/jpeg" }));
    expect(result.classId).toBe("no_damage");
    expect(result.severity).toBe("None");
  });

  it("disposes the prediction tensor even when the read rejects (no leak)", async () => {
    mockState.dataRejects = true;
    await expect(classifyImage(new Blob(["x"], { type: "image/jpeg" }))).rejects.toThrow();
    // Both tensors from the single execute() — probabilities and features — must be released.
    expect(mockState.dispose).toHaveBeenCalledTimes(2);
  });

  it("rejects (and still disposes) on a malformed output vector of the wrong length", async () => {
    mockState.probs = new Float32Array([0.5, 0.5]); // 2 entries != 3 classes
    await expect(classifyImage(new Blob(["x"], { type: "image/jpeg" }))).rejects.toThrow(
      /output length/i,
    );
    expect(mockState.dispose).toHaveBeenCalledTimes(2);
  });

  it("rejects when the output contains a non-finite probability", async () => {
    mockState.probs = new Float32Array([0.1, NaN, 0.2]);
    await expect(classifyImage(new Blob(["x"], { type: "image/jpeg" }))).rejects.toThrow(
      /non-finite/i,
    );
  });
});

// The defect these cover: a photograph of a person's face was returned as property damage at 94%,
// because a softmax over three classes has no way to answer "none of these". The class cannot be
// trusted until the features say the model has seen something like this before.
describe("classifyImage — the open-set gate", () => {
  const photo = () => new Blob(["x"], { type: "image/jpeg" });

  it("passes an in-domain photo through untouched, and says the gate ran", async () => {
    const result = await classifyImage(photo());
    expect(result.outOfDomain).toBe(false);
    expect(result.gateApplied).toBe(true);
    expect(result.classId).toBe("property_damage"); // argmax of [0.1, 0.05, 0.85]
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.domainDistance).toBeLessThanOrEqual(OOD_THRESHOLD);
    // Nothing was overruled, so there is no "what the softmax would have said" to record.
    expect(result.rawClassId).toBeNull();
    expect(result.rawConfidence).toBeNull();
  });

  it("returns no_damage for a photo outside every trained class, however confident the softmax", async () => {
    // Exactly the observed failure: a near-certain property_damage score on an image the model
    // has no concept for. The class must not survive the gate.
    mockState.probs = new Float32Array([0.03, 0.03, 0.94]);
    mockState.features = OUT_OF_DOMAIN_FEATURES;

    const result = await classifyImage(photo());
    expect(result.outOfDomain).toBe(true);
    expect(result.classId).toBe("no_damage");
    // "None" is what the compensation path needs: _map_damage_category returns None for a
    // no_damage case, so no estimate is generated and nothing can be paid on this photo.
    expect(result.severity).toBe("None");
    expect(result.confidence).toBe(0);
  });

  it("keeps the discarded closed-set answer so the research log can still report it", async () => {
    mockState.probs = new Float32Array([0.03, 0.03, 0.94]);
    mockState.features = OUT_OF_DOMAIN_FEATURES;

    const result = await classifyImage(photo());
    expect(result.rawClassId).toBe("property_damage");
    expect(result.rawConfidence).toBeCloseTo(0.94);
    expect(result.gateVersion).toBe(OOD_GATE_VERSION);
    expect(result.domainDistance).toBeGreaterThan(OOD_THRESHOLD);
  });

  it("still classifies when the feature node is missing, and does NOT claim the photo passed", async () => {
    // A re-exported model that renamed the node must not take the officer's tool offline. But
    // reporting outOfDomain: false with gateApplied: false is the honest description — nothing
    // was checked — and is what lets a broken gate be detected in the log rather than assumed away.
    mockState.executeThrows = true;

    const result = await classifyImage(photo());
    expect(result.classId).toBe("property_damage");
    expect(result.gateApplied).toBe(false);
    expect(result.outOfDomain).toBe(false);
    expect(result.domainDistance).toBeNull();
    expect(mockState.dispose).toHaveBeenCalledTimes(1); // predict() returns one tensor
  });

  it("does not gate on features of the wrong width — an unscoreable vector is not a rejection", async () => {
    mockState.features = new Float32Array(FEATURE_DIM - 1);

    const result = await classifyImage(photo());
    expect(result.gateApplied).toBe(false);
    expect(result.outOfDomain).toBe(false);
    expect(result.classId).toBe("property_damage");
  });
});
