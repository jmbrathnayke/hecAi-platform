// MobileNetV2 model loader (Story 3.2). The model is precached by the Service Worker
// (next.config.ts additionalPrecacheEntries) so `tf.loadLayersModel` resolves from the SW
// cache when offline — no application-level fetch/caching logic is needed here.
//
// Loading is expensive (~2s, allocates GPU/CPU memory), so `loadModel()` is a singleton:
// once resolved, later calls return the same instance immediately; concurrent calls while
// loading share the same in-flight promise instead of triggering duplicate loads.

import type { LayersModel } from "@tensorflow/tfjs";

export const MODEL_URL = "/models/mobilenetv2/model.json";

export class ModelNotAvailableError extends Error {
  constructor() {
    super("model.error");
    this.name = "ModelNotAvailableError";
  }
}

let modelInstance: LayersModel | null = null;
let loadPromise: Promise<LayersModel> | null = null;

export function loadModel(): Promise<LayersModel> {
  if (modelInstance) return Promise.resolve(modelInstance);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const tf = await import("@tensorflow/tfjs");
      await tf.ready();
      const model = await tf.loadLayersModel(MODEL_URL);
      modelInstance = model;
      return model;
    } catch {
      // Reset so a later reconnect can retry the load instead of staying stuck on failure.
      loadPromise = null;
      throw new ModelNotAvailableError();
    }
  })();

  return loadPromise;
}

// Test-only: reset module-level singleton state between test cases.
export function __resetModelForTests(): void {
  modelInstance = null;
  loadPromise = null;
}
