import { loadModel, ModelNotAvailableError, __resetModelForTests, MODEL_URL } from "@/lib/mobilenet";

const mockModel = { predict: jest.fn() };
const mockReady = jest.fn().mockResolvedValue(undefined);
const mockLoadGraphModel = jest.fn().mockResolvedValue(mockModel);

jest.mock("@tensorflow/tfjs", () => ({
  ready: (...args: unknown[]) => mockReady(...args),
  loadGraphModel: (...args: unknown[]) => mockLoadGraphModel(...args),
}));

beforeEach(() => {
  __resetModelForTests();
  mockReady.mockClear();
  mockLoadGraphModel.mockClear();
  mockLoadGraphModel.mockResolvedValue(mockModel);
});

describe("loadModel", () => {
  it("loads the model from the precached URL after tf.ready()", async () => {
    const model = await loadModel();
    expect(model).toBe(mockModel);
    expect(mockReady).toHaveBeenCalledTimes(1);
    expect(mockLoadGraphModel).toHaveBeenCalledWith(MODEL_URL);
  });

  it("returns the cached singleton instance without re-fetching on a later call", async () => {
    const first = await loadModel();
    const second = await loadModel();
    expect(second).toBe(first);
    expect(mockLoadGraphModel).toHaveBeenCalledTimes(1);
  });

  it("shares a single in-flight load across concurrent callers", async () => {
    const [a, b] = await Promise.all([loadModel(), loadModel()]);
    expect(a).toBe(b);
    expect(mockLoadGraphModel).toHaveBeenCalledTimes(1);
  });

  it("throws ModelNotAvailableError when the underlying load fails", async () => {
    mockLoadGraphModel.mockRejectedValueOnce(new Error("cache miss"));
    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);
  });

  it("allows a retry after a failed load (does not stay stuck on error)", async () => {
    mockLoadGraphModel.mockRejectedValueOnce(new Error("offline, no cache"));
    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);

    mockLoadGraphModel.mockResolvedValueOnce(mockModel);
    const model = await loadModel();
    expect(model).toBe(mockModel);
  });
});

// --- Stale Service Worker cache recovery -------------------------------------------------
// A device that visited before the model was re-exported holds the OLD precached model.json,
// and the SW answers from cache, so the fixed file on the server is never fetched. Observed on
// a real Chrome profile: the SW cache still held the `layers-model` export while the server was
// serving `graph-model`.
describe("loadModel stale-cache recovery", () => {
  const makeCaches = (urls: string[]) => {
    const deleted: string[] = [];
    const cache = {
      keys: jest.fn().mockResolvedValue(urls.map((url) => ({ url }))),
      delete: jest.fn(async (req: { url: string }) => {
        deleted.push(req.url);
        return true;
      }),
    };
    return {
      deleted,
      cache,
      api: { keys: jest.fn().mockResolvedValue(["serwist-precache-v2"]), open: jest.fn().mockResolvedValue(cache) },
    };
  };

  afterEach(() => {
    // @ts-expect-error test-only global
    delete global.caches;
    jest.restoreAllMocks();
  });

  it("purges the cached model and retries once when the first load fails", async () => {
    const { api, deleted } = makeCaches([
      "http://x/models/mobilenetv2/model.json",
      "http://x/models/mobilenetv2/group1-shard1of3.bin",
      "http://x/manifest.json",
    ]);
    // @ts-expect-error test-only global
    global.caches = api;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockLoadGraphModel
      .mockRejectedValueOnce(new Error("Corrupted configuration"))
      .mockResolvedValueOnce(mockModel);

    await expect(loadModel()).resolves.toBe(mockModel);
    expect(mockLoadGraphModel).toHaveBeenCalledTimes(2);
    // Only model files are purged — unrelated precache entries must survive.
    expect(deleted).toEqual([
      "http://x/models/mobilenetv2/model.json",
      "http://x/models/mobilenetv2/group1-shard1of3.bin",
    ]);
  });

  it("does NOT retry when there was nothing cached to purge", async () => {
    const { api } = makeCaches(["http://x/manifest.json"]);
    // @ts-expect-error test-only global
    global.caches = api;
    mockLoadGraphModel.mockRejectedValueOnce(new Error("offline"));

    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);
    expect(mockLoadGraphModel).toHaveBeenCalledTimes(1);
  });

  it("surfaces ModelNotAvailableError when the retry also fails", async () => {
    const { api } = makeCaches(["http://x/models/mobilenetv2/model.json"]);
    // @ts-expect-error test-only global
    global.caches = api;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockLoadGraphModel.mockRejectedValue(new Error("still broken"));

    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);
    expect(mockLoadGraphModel).toHaveBeenCalledTimes(2);
  });
});
