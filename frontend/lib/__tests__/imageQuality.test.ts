import { analyzeGrayscale } from "@/lib/imageQuality";

const SIZE = 16;

function flat(value: number): Float64Array {
  return new Float64Array(SIZE * SIZE).fill(value);
}

function checkerboard(): Float64Array {
  const g = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      g[y * SIZE + x] = (x + y) % 2 === 0 ? 0 : 255;
    }
  }
  return g;
}

describe("analyzeGrayscale", () => {
  it("flags a flat (no-detail) image as blurry", () => {
    const r = analyzeGrayscale(flat(128), SIZE);
    expect(r.blurry).toBe(true); // zero Laplacian variance
  });

  it("does not flag a high-detail (checkerboard) image as blurry", () => {
    const r = analyzeGrayscale(checkerboard(), SIZE);
    expect(r.blurry).toBe(false);
  });

  it("flags too-dark exposure", () => {
    expect(analyzeGrayscale(flat(10), SIZE).poorExposure).toBe(true);
  });

  it("flags too-bright exposure", () => {
    expect(analyzeGrayscale(flat(240), SIZE).poorExposure).toBe(true);
  });

  it("accepts well-exposed mid-brightness", () => {
    expect(analyzeGrayscale(flat(128), SIZE).poorExposure).toBe(false);
  });
});
