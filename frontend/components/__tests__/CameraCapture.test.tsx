import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { CameraCapture } from "@/components/CameraCapture";
import { assessFrameQuality } from "@/lib/imageQuality";

// next-intl passthrough: the translator returns the key (+ interpolation values), matching the
// convention in the officer page tests.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

jest.mock("@/lib/imageQuality", () => ({ assessFrameQuality: jest.fn() }));
const mockAssess = assessFrameQuality as jest.Mock;

/** A MediaStream stand-in whose tracks record that stop() was called. */
function fakeStream() {
  const track = { stop: jest.fn(), kind: "video" };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function setMediaDevices(getUserMedia: unknown) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: getUserMedia ? { getUserMedia } : undefined,
    configurable: true,
    writable: true,
  });
}

/** jsdom implements neither video playback nor a canvas backend — stub just enough of both. */
function stubMediaPrimitives({ blob }: { blob: Blob | null } = { blob: new Blob(["x"]) }) {
  HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 1920,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 1080,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "readyState", { configurable: true, get: () => 4 });
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({ drawImage: jest.fn() })) as never;
  HTMLCanvasElement.prototype.toBlob = jest.fn((cb: BlobCallback) => cb(blob)) as never;
}

beforeEach(() => {
  mockAssess.mockReset().mockReturnValue({ blurry: false, poorExposure: false });
  jest.restoreAllMocks();
});

afterEach(() => {
  setMediaDevices(undefined);
});

describe("CameraCapture", () => {
  it("falls back to the gallery panel when the device exposes no MediaDevices at all", async () => {
    setMediaDevices(undefined);
    render(<CameraCapture onCapture={jest.fn()} fileInputTestId="fallback-input" />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "unavailable"),
    );
    expect(screen.getByText("camera.unavailableTitle")).toBeInTheDocument();
    // The documented fallback stays reachable — this is the only capture route in this state.
    expect(screen.getByTestId("fallback-input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "camera.gallery" })).toBeInTheDocument();
  });

  it("opens the rear camera and shows the viewfinder controls", async () => {
    stubMediaPrimitives();
    const { stream } = fakeStream();
    const getUserMedia = jest.fn().mockResolvedValue(stream);
    setMediaDevices(getUserMedia);

    render(<CameraCapture onCapture={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    expect(screen.getByTestId("camera-shutter")).toBeInTheDocument();
    // No external app launch: the capture affordance is the in-page shutter, not the OS picker.
    expect(screen.getByTestId("camera-video")).toBeInTheDocument();
  });

  it("explains a denied permission inline and offers Retry (never the browser's own error)", async () => {
    const getUserMedia = jest
      .fn()
      .mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    setMediaDevices(getUserMedia);

    render(<CameraCapture onCapture={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "denied"),
    );
    expect(screen.getByText("camera.deniedTitle")).toBeInTheDocument();
    expect(screen.getByText("camera.deniedBody")).toBeInTheDocument();

    // Retry re-runs getUserMedia rather than making the officer reload the page.
    fireEvent.click(screen.getByRole("button", { name: "camera.retry" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  it("distinguishes 'no camera on this device' from a denied permission", async () => {
    setMediaDevices(jest.fn().mockRejectedValue(new DOMException("none", "NotFoundError")));
    render(<CameraCapture onCapture={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "unavailable"),
    );
    expect(screen.getByText("camera.unavailableTitle")).toBeInTheDocument();
    expect(screen.queryByText("camera.deniedTitle")).not.toBeInTheDocument();
  });

  it("grabs a JPEG still from the live preview when the shutter is tapped", async () => {
    stubMediaPrimitives({ blob: new Blob(["frame"], { type: "image/jpeg" }) });
    const { stream } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));
    const onCapture = jest.fn();

    render(<CameraCapture onCapture={onCapture} />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );

    fireEvent.click(screen.getByTestId("camera-shutter"));

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0][0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
  });

  it("ignores a second shutter tap while the first frame is still encoding", async () => {
    stubMediaPrimitives();
    const { stream } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));
    // Hold toBlob open so both taps land inside the same in-flight window.
    let release!: () => void;
    HTMLCanvasElement.prototype.toBlob = jest.fn((cb: BlobCallback) => {
      release = () => cb(new Blob(["frame"], { type: "image/jpeg" }));
    }) as never;
    const onCapture = jest.fn();

    render(<CameraCapture onCapture={onCapture} />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );

    fireEvent.click(screen.getByTestId("camera-shutter"));
    fireEvent.click(screen.getByTestId("camera-shutter"));
    await act(async () => {
      release();
    });

    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it("passes a gallery-picked file through the same handler as the shutter", async () => {
    setMediaDevices(undefined);
    const onCapture = jest.fn();
    render(<CameraCapture onCapture={onCapture} fileInputTestId="fallback-input" />);

    const file = new File(["x"], "damage.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("fallback-input"), { target: { files: [file] } });

    expect(onCapture).toHaveBeenCalledWith(file);
  });

  it("releases the camera when unmounted, so the capture LED does not stay on", async () => {
    stubMediaPrimitives();
    const { stream, track } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));

    const { unmount } = render(<CameraCapture onCapture={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );

    unmount();
    expect(track.stop).toHaveBeenCalled();
  });

  it("releases a stream that arrives after the component has already unmounted", async () => {
    stubMediaPrimitives();
    const { stream, track } = fakeStream();
    let resolveMedia!: (s: MediaStream) => void;
    setMediaDevices(jest.fn(() => new Promise((res) => { resolveMedia = res as (s: MediaStream) => void; })));

    const { unmount } = render(<CameraCapture onCapture={jest.fn()} />);
    unmount();
    await act(async () => {
      resolveMedia(stream);
    });

    expect(track.stop).toHaveBeenCalled();
  });

  it("reports the live quality verdict in the badge", async () => {
    jest.useFakeTimers();
    stubMediaPrimitives();
    const { stream } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));
    mockAssess.mockReturnValue({ blurry: true, poorExposure: false });

    render(<CameraCapture onCapture={jest.fn()} />);
    // Let the getUserMedia promise settle, then advance past one sampling tick.
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId("camera-quality-badge")).toHaveAttribute("data-quality", "blurry");
    jest.useRealTimers();
  });

  it("keeps the back affordance when the camera is unusable — it is the host's only way out", async () => {
    // On the officer-assisted submit flow the camera is full-bleed and onBack is the ONLY route
    // back to the damage step, so a denied permission must not strand the officer there.
    setMediaDevices(jest.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    const onBack = jest.fn();
    render(<CameraCapture onCapture={jest.fn()} onBack={onBack} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "denied"),
    );
    fireEvent.click(screen.getByRole("button", { name: "camera.back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders exactly one back button once the camera comes up", async () => {
    stubMediaPrimitives();
    const { stream } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));

    render(<CameraCapture onCapture={jest.fn()} onBack={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );

    // getByRole throws on duplicates — the live overlay's copy must replace the fallback one.
    expect(screen.getByRole("button", { name: "camera.back" })).toBeInTheDocument();
  });

  it("shows no back button at all when the host provides no handler", async () => {
    setMediaDevices(undefined);
    render(<CameraCapture onCapture={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "unavailable"),
    );
    expect(screen.queryByRole("button", { name: "camera.back" })).not.toBeInTheDocument();
  });

  it("locks the shutter at the photo cap", async () => {
    stubMediaPrimitives();
    const { stream } = fakeStream();
    setMediaDevices(jest.fn().mockResolvedValue(stream));

    render(<CameraCapture onCapture={jest.fn()} atMax />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "live"),
    );

    expect(screen.getByTestId("camera-shutter")).toBeDisabled();
    expect(screen.getByRole("button", { name: "camera.gallery" })).toBeDisabled();
  });
});
