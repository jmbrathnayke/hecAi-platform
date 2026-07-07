import { getCurrentPosition, GpsTimeoutError } from "@/lib/geolocation";

describe("getCurrentPosition", () => {
  const original = navigator.geolocation;
  afterEach(() => {
    Object.defineProperty(navigator, "geolocation", { value: original, configurable: true });
  });

  it("resolves with coordinates on success", async () => {
    const coords = { latitude: 7.87, longitude: 80.77 } as GeolocationCoordinates;
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (ok: (p: { coords: GeolocationCoordinates }) => void) => ok({ coords }) },
      configurable: true,
    });
    await expect(getCurrentPosition()).resolves.toEqual(coords);
  });

  it("rejects with GpsTimeoutError on geolocation error", async () => {
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) => err(new Error("denied")) },
      configurable: true,
    });
    await expect(getCurrentPosition()).rejects.toBeInstanceOf(GpsTimeoutError);
  });

  it("rejects with GpsTimeoutError when geolocation is unavailable", async () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    await expect(getCurrentPosition()).rejects.toBeInstanceOf(GpsTimeoutError);
  });
});
