// One-shot GPS capture with a timeout. On failure/timeout the caller falls back to a
// manual map-pin picker (FR-1.6). We deliberately use getCurrentPosition (not
// watchPosition) to avoid draining the battery for a single capture.

export class GpsTimeoutError extends Error {
  constructor() {
    super("GPS timed out");
    this.name = "GpsTimeoutError";
  }
}

export function getCurrentPosition(timeoutMs = 10000): Promise<GeolocationCoordinates> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new GpsTimeoutError());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => reject(new GpsTimeoutError()),
      { timeout: timeoutMs, enableHighAccuracy: true },
    );
  });
}
