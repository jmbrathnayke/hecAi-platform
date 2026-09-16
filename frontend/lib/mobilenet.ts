// MobileNetV2 model loader + on-device classification (Stories 3.2, 3.3). The model is
// precached by the Service Worker (next.config.ts additionalPrecacheEntries) so
// `tf.loadLayersModel` resolves from the SW cache when offline — no application-level
// fetch/caching logic is needed here.
//
// Loading is expensive (~2s, allocates GPU/CPU memory), so `loadModel()` is a singleton:
// once resolved, later calls return the same instance immediately; concurrent calls while
// loading share the same in-flight promise instead of triggering duplicate loads.

import type { GraphModel, Tensor } from "@tensorflow/tfjs";
// Story 3.3: statically imported (NOT fetched at runtime) so they are bundled into the
// precached JS chunks and therefore available offline. class_names.json is the model's
// output-class order; severity_mapping.json is the confidence-band rule the training
// pipeline emitted. Both are excluded from the SW precache list (next.config.ts) precisely
// because a static import already carries them.
import classNames from "@/public/models/mobilenetv2/class_names.json";
import severityMapping from "@/public/models/mobilenetv2/severity_mapping.json";

export const MODEL_URL = "/models/mobilenetv2/model.json";

// Tagged on every inference and persisted to the case draft as `ai_model_version`; the sync
// path (Story 3.4) forwards it to inference_log.model_version for the research benchmark.
export const MODEL_VERSION = "mobilenetv2-v1";

// 224×224 RGB is MobileNetV2's fixed input geometry (model.json InputLayer [null,224,224,3]).
export const INPUT_SIZE = 224;

export type ClassId = (typeof classNames)[number]; // "crop_damage" | "no_damage" | "property_damage"
export type Severity = "None" | "Minor" | "Moderate" | "Severe";

export interface ClassificationResult {
  classId: ClassId;
  severity: Severity;
  confidence: number; // 0..1
  processingTimeMs: number; // end-to-end: decode + resize + inference (AC4 capture→result), not pure forward-pass
  modelVersion: string;
}

export class ModelNotAvailableError extends Error {
  constructor(cause?: unknown) {
    super("AI model could not be loaded", { cause });
    this.name = "ModelNotAvailableError";
  }
}

let modelInstance: GraphModel | null = null;
let loadPromise: Promise<GraphModel> | null = null;

/**
 * Delete every cached `/models/mobilenetv2/` entry from all Cache Storage buckets.
 * Returns true if anything was actually removed.
 *
 * WHY THIS IS NEEDED. The Service Worker precaches model.json and the weight shards
 * (next.config.ts additionalPrecacheEntries). A device that visited the app before the model was
 * re-exported holds the OLD entries, and the SW answers from cache — so the fixed file on the
 * server is never fetched and the load keeps failing with the officer none the wiser. This was
 * observed on a real profile: the browser's SW cache still contained the `layers-model` /
 * `batch_shape` export long after the server was serving `graph-model`.
 *
 * Purging lets the retry fall through to the network. Safe to call when offline: the delete
 * succeeds, the retry then fails, and the caller reports the same error it would have anyway.
 */
async function purgeCachedModel(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  let purged = false;
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (request.url.includes("/models/mobilenetv2/")) {
          purged = (await cache.delete(request)) || purged;
        }
      }
    }
  } catch {
    // Cache Storage can throw in private browsing or when storage is evicted mid-iteration.
    // A failed purge just means the retry is pointless, not that anything is broken.
    return purged;
  }
  return purged;
}

export function loadModel(): Promise<GraphModel> {
  if (modelInstance) return Promise.resolve(modelInstance);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const tf = await import("@tensorflow/tfjs");
      await tf.ready();
      // loadGraphModel, NOT loadLayersModel. The model is exported from Keras 3, and
      // tfjs-layers 4.22.0 cannot deserialize a Keras 3 layers model at all: InputLayer is
      // emitted with `batch_shape` where tfjs expects `batch_input_shape`, and `inbound_nodes`
      // is an object where tfjs expects an array. Loading the old layers export threw
      // "An InputLayer should be passed either a `batchInputShape` or an `inputShape`" for
      // every user, on every device -- and no test caught it because the tests mock
      // @tensorflow/tfjs wholesale and never touch a real weight file. The graph-model export
      // is the supported Keras 3 path; scripts/tfjs-bench/verify-model.mjs asserts it
      // reproduces the Keras probabilities (argmax 8/8, max |Δp| 2e-6).
      let model: GraphModel;
      try {
        model = await tf.loadGraphModel(MODEL_URL);
      } catch (first) {
        // A stale Service Worker cache is the most likely reason a model that parses on the
        // server fails on the device — see purgeCachedModel(). Retry exactly once, and only if
        // there was actually something to purge, so a genuinely offline device still fails fast
        // instead of loading twice.
        if (!(await purgeCachedModel())) throw first;
        console.warn(
          "[mobilenet] model load failed; purged stale cached model and retrying once",
          first,
        );
        model = await tf.loadGraphModel(MODEL_URL);
      }
      modelInstance = model;
      return model;
    } catch (err) {
      // Reset so a later reconnect can retry the load instead of staying stuck on failure.
      loadPromise = null;
      throw new ModelNotAvailableError(err);
    }
  })();

  return loadPromise;
}

// Test-only: reset module-level singleton state between test cases.
export function __resetModelForTests(): void {
  modelInstance = null;
  loadPromise = null;
}

// ---------------------------------------------------------------------------
// Classification (Story 3.3)
// ---------------------------------------------------------------------------

/**
 * Pure argmax over the model's softmax output. `probs` is the raw output in
 * `class_names.json` order; returns the winning class and its confidence (0..1).
 * Separated from tensor/canvas code so the decision logic is unit-testable.
 */
export function topClass(probs: ArrayLike<number>): { classId: ClassId; confidence: number } {
  let bestIndex = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[bestIndex]) bestIndex = i;
  }
  return { classId: classNames[bestIndex] as ClassId, confidence: probs[bestIndex] ?? 0 };
}

/**
 * Map a class + confidence to a severity via severity_mapping.json's confidence-band rule:
 * the no-damage class is always "None"; otherwise the first band whose `min_confidence` the
 * confidence meets (bands are ordered high→low). Pure and unit-testable.
 */
export function resolveSeverity(classId: ClassId, confidence: number): Severity {
  if (classId === severityMapping.no_damage_class) {
    return severityMapping.no_damage_severity as Severity;
  }
  for (const band of severityMapping.bands) {
    if (confidence >= band.min_confidence) return band.severity as Severity;
  }
  // bands always include a min_confidence: 0 floor, so this is unreachable in practice.
  return "Minor";
}

/**
 * Decode a photo Blob, resize to 224×224 via OffscreenCanvas, and return its ImageData.
 * Browser-only (createImageBitmap / OffscreenCanvas). Mirrors lib/imageQuality.ts, including
 * the explicit 4-arg drawImage fallback for webviews that ignore createImageBitmap resizing.
 */
async function blobToImageData(blob: Blob, size: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: "medium",
  });
  try {
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (typeof OffscreenCanvas !== "undefined") {
      ctx = new OffscreenCanvas(size, size).getContext("2d");
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      ctx = canvas.getContext("2d");
    }
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  } finally {
    bitmap.close();
  }
}

/**
 * Classify a damage photo entirely on-device (FR-2.1, FR-2.2). Resizes to 224×224 via
 * OffscreenCanvas, normalizes pixels to [0, 1], runs the cached MobileNetV2 through TF.js,
 * and returns the top class + severity + confidence + end-to-end processing time (decode +
 * resize + inference; matches AC4's capture→result budget, NOT pure forward-pass time).
 * Reuses the `loadModel()` singleton — no second model-loading path.
 */
export async function classifyImage(blob: Blob): Promise<ClassificationResult> {
  const model = await loadModel();
  const tf = await import("@tensorflow/tfjs");
  const start = performance.now();

  const imageData = await blobToImageData(blob, INPUT_SIZE);
  // tidy() disposes the intermediate tensors (fromPixels → float → /255 → batch dim) but
  // keeps the returned prediction tensor, which we read then dispose ourselves.
  const output = tf.tidy(() => {
    const input = tf.browser.fromPixels(imageData).toFloat().div(255).expandDims(0);
    // GraphModel.predict is typed Tensor | Tensor[] | NamedTensorMap — this model has a single
    // output, but the old `as Tensor` cast would have turned a multi-output export into an
    // `output.data is not a function` crash rather than a clear message.
    const result = model.predict(input);
    return (Array.isArray(result) ? result[0] : result) as Tensor;
  });
  let probs: ArrayLike<number>;
  try {
    probs = await output.data();
  } finally {
    // Dispose even if the read rejects (e.g. lost WebGL context) so the tensor never leaks.
    output.dispose();
  }

  // Guard a malformed output vector: it must carry exactly one finite probability per class.
  // Otherwise argmax would silently return crop_damage@0 / an undefined class / a NaN
  // confidence that then flows into severity, persistence, and the result card.
  if (probs.length !== classNames.length) {
    throw new Error(
      `unexpected model output length ${probs.length} (expected ${classNames.length})`,
    );
  }
  for (let i = 0; i < probs.length; i++) {
    if (!Number.isFinite(probs[i])) {
      throw new Error("model output contains a non-finite value");
    }
  }

  const processingTimeMs = performance.now() - start;
  const { classId, confidence } = topClass(probs);
  return {
    classId,
    severity: resolveSeverity(classId, confidence),
    confidence,
    processingTimeMs,
    modelVersion: MODEL_VERSION,
  };
}
