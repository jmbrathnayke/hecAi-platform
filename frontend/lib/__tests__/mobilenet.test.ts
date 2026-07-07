import { loadModel, ModelNotAvailableError, __resetModelForTests, MODEL_URL } from "@/lib/mobilenet";

const mockModel = { predict: jest.fn() };
const mockReady = jest.fn().mockResolvedValue(undefined);
const mockLoadLayersModel = jest.fn().mockResolvedValue(mockModel);

jest.mock("@tensorflow/tfjs", () => ({
  ready: (...args: unknown[]) => mockReady(...args),
  loadLayersModel: (...args: unknown[]) => mockLoadLayersModel(...args),
}));

beforeEach(() => {
  __resetModelForTests();
  mockReady.mockClear();
  mockLoadLayersModel.mockClear();
  mockLoadLayersModel.mockResolvedValue(mockModel);
});

describe("loadModel", () => {
  it("loads the model from the precached URL after tf.ready()", async () => {
    const model = await loadModel();
    expect(model).toBe(mockModel);
    expect(mockReady).toHaveBeenCalledTimes(1);
    expect(mockLoadLayersModel).toHaveBeenCalledWith(MODEL_URL);
  });

  it("returns the cached singleton instance without re-fetching on a later call", async () => {
    const first = await loadModel();
    const second = await loadModel();
    expect(second).toBe(first);
    expect(mockLoadLayersModel).toHaveBeenCalledTimes(1);
  });

  it("shares a single in-flight load across concurrent callers", async () => {
    const [a, b] = await Promise.all([loadModel(), loadModel()]);
    expect(a).toBe(b);
    expect(mockLoadLayersModel).toHaveBeenCalledTimes(1);
  });

  it("throws ModelNotAvailableError when the underlying load fails", async () => {
    mockLoadLayersModel.mockRejectedValueOnce(new Error("cache miss"));
    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);
  });

  it("allows a retry after a failed load (does not stay stuck on error)", async () => {
    mockLoadLayersModel.mockRejectedValueOnce(new Error("offline, no cache"));
    await expect(loadModel()).rejects.toBeInstanceOf(ModelNotAvailableError);

    mockLoadLayersModel.mockResolvedValueOnce(mockModel);
    const model = await loadModel();
    expect(model).toBe(mockModel);
  });
});
