// On-capture photo quality check (FR-1.5, UX-DR6): blur via Laplacian variance,
// exposure via mean brightness. Runs on a small thumbnail so it stays well under 1s.

const THUMB_SIZE = 128;
const BLUR_THRESHOLD = 100; // Laplacian variance below this → blurry
const EXPOSURE_LOW = 40;
const EXPOSURE_HIGH = 220;

export interface QualityResult {
  blurry: boolean;
  poorExposure: boolean;
}

/**
 * Pure analysis over a grayscale (luminance) buffer of size*size pixels.
 * Separated from canvas/DOM so it can be unit-tested.
 */
export function analyzeGrayscale(gray: ArrayLike<number>, size: number): QualityResult {
  let brightnessSum = 0;
  for (let i = 0; i < gray.length; i++) brightnessSum += gray[i];
  const meanBrightness = brightnessSum / gray.length;

  // Laplacian variance (focus measure).
  let lapSum = 0;
  let lapSumSq = 0;
  const count = (size - 2) * (size - 2);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const lap =
        -gray[(y - 1) * size + x] +
        -gray[y * size + (x - 1)] +
        4 * gray[y * size + x] +
        -gray[y * size + (x + 1)] +
        -gray[(y + 1) * size + x];
      lapSum += lap;
      lapSumSq += lap * lap;
    }
  }
  const mean = count > 0 ? lapSum / count : 0;
  const variance = count > 0 ? lapSumSq / count - mean * mean : 0;

  return {
    blurry: variance < BLUR_THRESHOLD,
    poorExposure: meanBrightness < EXPOSURE_LOW || meanBrightness > EXPOSURE_HIGH,
  };
}

/** A THUMB_SIZE² scratch 2d context, preferring OffscreenCanvas where the browser has it. */
function thumbnailContext(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE).getContext("2d");
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    ctx = canvas.getContext("2d");
  }
  if (!ctx) throw new Error("canvas 2d context unavailable");
  return ctx;
}

/**
 * Downscale any canvas-drawable source to the thumbnail and assess blur + exposure.
 * Synchronous, so the officer camera's live badge can sample a <video> element on a
 * timer without awaiting a decode. Throws if no canvas context is available, or if the
 * source is not yet drawable (a <video> with no frame produces a tainted/empty read).
 */
export function assessFrameQuality(source: CanvasImageSource): QualityResult {
  const ctx = thumbnailContext();

  // 4-arg drawImage scales the source to fill the thumbnail — without it we would analyze
  // only the top-left 128px corner of a full-resolution frame.
  ctx.drawImage(source, 0, 0, THUMB_SIZE, THUMB_SIZE);

  const { data } = ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE);
  const gray = new Float64Array(THUMB_SIZE * THUMB_SIZE);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return analyzeGrayscale(gray, THUMB_SIZE);
}

/**
 * Decode a photo Blob, downscale to a thumbnail, and assess blur + exposure.
 * Throws if the Blob cannot be decoded as an image (corrupt / non-image /
 * unsupported format) or no canvas context is available — callers treat a throw
 * as "this file is not a usable photo".
 */
export async function assessImageQuality(blob: Blob): Promise<QualityResult> {
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: THUMB_SIZE,
    resizeHeight: THUMB_SIZE,
    resizeQuality: "low",
  });

  try {
    return assessFrameQuality(bitmap);
  } finally {
    bitmap.close();
  }
}
