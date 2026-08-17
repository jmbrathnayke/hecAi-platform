import {
  topClass,
  resolveSeverity,
  classifyImage,
  MODEL_VERSION,
  INPUT_SIZE,
  __resetModelForTests,
} from "@/lib/mobilenet";

// Mutable holder so individual tests can steer the model's softmax output, force the tensor
// read to reject, and observe disposal. Prefixed `mock` so jest's out-of-scope-reference
// guard permits the factory to close over it.
const mockState = {
  probs: new Float32Array([0.1, 0.05, 0.85]) as ArrayLike<number>,
  dataRejects: false,
  dispose: jest.fn(),
};

jest.mock("@tensorflow/tfjs", () => {
  // A chainable stub for `fromPixels(imageData).toFloat().div(255).expandDims(0)`.
  const chain = {
    toFloat: () => chain,
    div: () => chain,
    expandDims: () => chain,
  };
  return {
    ready: jest.fn().mockResolvedValue(undefined),
    loadGraphModel: jest.fn().mockResolvedValue({
      predict: () => ({
        data: () =>
          mockState.dataRejects
            ? Promise.reject(new Error("tensor read failed"))
            : Promise.resolve(mockState.probs),
        dispose: mockState.dispose,
      }),
    }),
    tidy: (fn: () => unknown) => fn(),
    browser: { fromPixels: () => chain },
  };
});

beforeEach(() => {
  __resetModelForTests();
  mockState.probs = new Float32Array([0.1, 0.05, 0.85]);
  mockState.dataRejects = false;
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
    expect(mockState.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects (and still disposes) on a malformed output vector of the wrong length", async () => {
    mockState.probs = new Float32Array([0.5, 0.5]); // 2 entries != 3 classes
    await expect(classifyImage(new Blob(["x"], { type: "image/jpeg" }))).rejects.toThrow(
      /output length/i,
    );
    expect(mockState.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects when the output contains a non-finite probability", async () => {
    mockState.probs = new Float32Array([0.1, NaN, 0.2]);
    await expect(classifyImage(new Blob(["x"], { type: "image/jpeg" }))).rejects.toThrow(
      /non-finite/i,
    );
  });
});
