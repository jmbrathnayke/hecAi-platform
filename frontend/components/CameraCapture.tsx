"use client";

// In-app camera capture (officer-camera.html mockup screen 1; EXPERIENCE.md § Device Capabilities:
// "Native camera API — in-app capture on Officer Camera screen. No external app launch.").
//
// Replaces the previous `<input type="file" capture="environment">` on the officer screens, which
// handed the officer off to the OS camera app: they lost the step bar, the live quality signal and
// the running photo count, and on several Android builds came back to a re-mounted page. This
// component keeps capture inside the PWA via MediaDevices + a canvas grab.
//
// Two deliberate deviations from the mockup's CSS, both from the spine (EXPERIENCE.md wins on
// conflict — see its § Mockups note):
//   1. § Sunlight legibility: "Use solid backgrounds (no translucent panels) on camera overlay."
//      The mockup's rgba() badge / back button / gallery button are painted solid here. The
//      top+bottom scrim gradients stay: they carry no text, and they exist precisely to hold
//      contrast under the controls.
//   2. § Permissions: "if denied, show inline explanation and link to device settings. Never show
//      browser's default permission error." Hence the three explicit fallback panels below rather
//      than letting getUserMedia's rejection surface untreated.
//
// The gallery file input is rendered in EVERY state, including while the live camera is running.
// It is the documented fallback (EXPERIENCE.md § Camera Capture: "Fallback: gallery file picker"),
// and it is what keeps this component usable where `mediaDevices` does not exist at all.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { assessFrameQuality } from "@/lib/imageQuality";

/** How often the live badge re-samples the preview. Fast enough to feel live, slow enough that
 *  the 128² Laplacian never competes with the render loop on a low-end field device. */
const SAMPLE_MS = 700;
/** Longest edge of a captured still. Full sensor resolution is wasted here — the photo is fed to
 *  a 224² MobileNetV2 and stored in IndexedDB on a device with a metered, intermittent uplink. */
const MAX_CAPTURE_EDGE = 1600;
const JPEG_QUALITY = 0.85;

type CameraState = "starting" | "live" | "denied" | "unavailable" | "failed";
type Quality = "checking" | "good" | "blurry" | "exposure";

export interface CameraCaptureProps {
  /** Called with the captured still (shutter) or the picked file (gallery fallback). */
  onCapture: (file: File) => void;
  /** Blocks the shutter and shows the busy overlay while the parent classifies. */
  disabled?: boolean;
  /** Overlay caption while `disabled` — e.g. "Analyzing photo…". */
  busyLabel?: string;
  /** Hard cap; the shutter and gallery button both lock out once reached. */
  atMax?: boolean;
  /** Object URLs for the mockup's bottom-left recent-capture strip (newest last). */
  thumbnails?: string[];
  /** Renders the mockup's top-left back affordance when provided. */
  onBack?: () => void;
  /** Test id for the fallback file input, so each host page can keep its existing selector. */
  fileInputTestId?: string;
}

export function CameraCapture({
  onCapture,
  disabled = false,
  busyLabel,
  atMax = false,
  thumbnails = [],
  onBack,
  fileInputTestId,
}: CameraCaptureProps) {
  const t = useTranslations("officer");
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  // Serializes shutter presses: toBlob is async, and the button's `disabled` only takes effect
  // after the next React render, so a double-tap would otherwise grab two frames.
  const capturingRef = useRef(false);

  const [state, setState] = useState<CameraState>("starting");
  const [quality, setQuality] = useState<Quality>("checking");
  const [captureError, setCaptureError] = useState(false);
  // Bumped by Retry to re-run the start effect — setState to the same value would be an
  // Object.is no-op and would not re-trigger it.
  const [retryNonce, setRetryNonce] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // ---- Start / stop the stream -------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function start() {
      // No MediaDevices at all: an insecure origin, an old webview, or jsdom under test. Fall
      // straight through to the gallery panel rather than throwing.
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) setState("unavailable");
        return;
      }
      setState("starting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Rear camera for damage documentation. `ideal` (not `exact`) so a laptop/front-only
          // device still gets a working camera instead of an OverconstrainedError.
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        // Unmounted (or retried) while getUserMedia was in flight — release the camera
        // immediately, otherwise the device's capture LED stays on with nothing rendering it.
        if (cancelled || !mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Autoplay can still reject (backgrounded tab, iOS gesture policy); the preview simply
          // stays black in that case, which the quality badge already communicates.
          videoRef.current.play().catch(() => {});
        }
        setState("live");
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setState("denied");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setState("unavailable");
        } else {
          setState("failed");
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      stopStream();
    };
  }, [retryNonce, stopStream]);

  // ---- Live quality badge -------------------------------------------------
  useEffect(() => {
    if (state !== "live") return;
    setQuality("checking");
    const id = setInterval(() => {
      const video = videoRef.current;
      // HAVE_CURRENT_DATA — before this there is no frame to draw and getImageData would
      // report a uniformly black (i.e. "poorly exposed") reading.
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      try {
        const result = assessFrameQuality(video);
        if (result.blurry) setQuality("blurry");
        else if (result.poorExposure) setQuality("exposure");
        else setQuality("good");
      } catch {
        // A frame we cannot read is not a reason to nag the officer — leave the badge on its
        // last verdict and try again on the next tick.
      }
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [state]);

  // ---- Shutter ------------------------------------------------------------
  async function handleShutter() {
    if (disabled || atMax || capturingRef.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      setCaptureError(true);
      return;
    }
    capturingRef.current = true;
    setCaptureError(false);
    try {
      const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setCaptureError(true);
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
      });
      if (!mountedRef.current) return;
      if (!blob) {
        setCaptureError(true);
        return;
      }
      onCapture(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }));
    } catch {
      if (mountedRef.current) setCaptureError(true);
    } finally {
      capturingRef.current = false;
    }
  }

  // ---- Gallery fallback ---------------------------------------------------
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setCaptureError(false);
    onCapture(file);
  }

  const badgeText =
    quality === "good"
      ? t("camera.badgeGood")
      : quality === "blurry"
        ? t("camera.badgeBlurry")
        : quality === "exposure"
          ? t("camera.badgeExposure")
          : t("camera.badgeChecking");
  // Solid fills, per § Sunlight legibility. status-warning is a light amber, so it takes
  // ink-primary text rather than white to stay above 4.5:1.
  const badgeTone =
    quality === "good"
      ? "bg-status-success text-ink-on-dark"
      : quality === "checking"
        ? "bg-ink-secondary text-ink-on-dark"
        : "bg-status-warning text-ink-primary";

  // Rendered in the live overlay AND over the fallback/starting panels. On the officer-assisted
  // submit flow this is the ONLY backward navigation out of the photo step, so gating it on a
  // working camera would strand the officer on a denied permission or a device with no camera.
  const backButton = onBack ? (
    <button
      type="button"
      onClick={onBack}
      aria-label={t("camera.back")}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-ink-primary text-ink-on-dark"
    >
      <span aria-hidden="true">←</span>
    </button>
  ) : (
    <span className="h-9 w-9 shrink-0" aria-hidden="true" />
  );

  const fallback =
    state === "denied"
      ? { title: t("camera.deniedTitle"), body: t("camera.deniedBody"), retry: true }
      : state === "failed"
        ? { title: t("camera.failedTitle"), body: t("camera.failedBody"), retry: true }
        : state === "unavailable"
          ? { title: t("camera.unavailableTitle"), body: t("camera.unavailableBody"), retry: false }
          : null;

  return (
    <div data-testid="camera-capture" data-state={state}>
      {/* Fixed 4:3-ish viewport so the step bar above and the instruction strip below never
          reflow as the stream resolution resolves. */}
      <div className="relative h-[340px] w-full overflow-hidden bg-ink-primary">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a live camera preview has no
            audio track and nothing to caption. */}
        <video
          ref={videoRef}
          data-testid="camera-video"
          autoPlay
          playsInline
          muted
          aria-label={t("camera.viewfinderLabel")}
          className={`h-full w-full object-cover ${state === "live" ? "" : "invisible"}`}
        />

        {state === "starting" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-design-3"
            role="status"
            aria-live="polite"
          >
            <span
              className="h-8 w-8 animate-spin rounded-pill border-2 border-border-strong border-t-forest-pale motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-label text-ink-on-dark">{t("camera.starting")}</p>
          </div>
        )}

        {fallback && (
          // role="status" (polite), not "alert": this panel is rendered in place of the
          // viewfinder the officer is already looking at and stays for as long as the camera is
          // unusable. An assertive alert would interrupt whatever else is being announced, and
          // would make every transient page error ambiguous to query alongside it.
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-design-3 px-design-5 text-center"
            role="status"
          >
            <span className="text-3xl" aria-hidden="true">
              📷
            </span>
            <p className="text-headline text-ink-on-dark">{fallback.title}</p>
            <p className="text-caption leading-relaxed text-border-default">{fallback.body}</p>
            {fallback.retry && (
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="min-h-touch-target rounded-md border border-ink-on-dark px-design-5 text-label font-semibold text-ink-on-dark"
              >
                {t("camera.retry")}
              </button>
            )}
          </div>
        )}

        {/* Same back affordance over the starting spinner and the fallback panels, where there is
            no top overlay to hold it. Rendered after them so it paints above. */}
        {state !== "live" && onBack && (
          <div className="absolute left-design-3 top-design-3">{backButton}</div>
        )}

        {state === "live" && (
          <>
            {/* Focus reticle — four corner brackets, purely a framing aid. */}
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 h-[120px] w-[120px] -translate-x-1/2 -translate-y-1/2"
              aria-hidden="true"
            >
              <span className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-ink-on-dark" />
              <span className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-ink-on-dark" />
              <span className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-ink-on-dark" />
              <span className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-ink-on-dark" />
            </div>

            {/* Top overlay: back + live quality badge. */}
            <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-design-2 bg-gradient-to-b from-black/60 to-transparent p-design-3">
              {backButton}
              <span
                data-testid="camera-quality-badge"
                data-quality={quality}
                role="status"
                aria-live="polite"
                className={`rounded-pill px-design-3 py-design-1 text-caption font-semibold ${badgeTone}`}
              >
                {quality === "good" ? `✓ ${badgeText}` : badgeText}
              </span>
              <span className="h-9 w-9 shrink-0" aria-hidden="true" />
            </div>

            {/* Bottom overlay: recent captures, shutter, gallery. */}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-design-3 bg-gradient-to-t from-black/70 to-transparent p-design-4">
              <ul className="flex w-10 shrink-0 gap-design-1" aria-label={t("camera.recentAria")}>
                {/* Newest two only — the full set lives in the photo strip under the camera. */}
                {thumbnails.slice(-2).map((url) => (
                  <li key={url}>
                    {/* Plain <img>: blob: object URLs cannot be optimised by next/image, and this
                        screen must work with no network at all. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      className="h-10 w-10 rounded-sm border-2 border-ink-on-dark object-cover"
                    />
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => void handleShutter()}
                disabled={disabled || atMax}
                aria-label={t("camera.shutter")}
                data-testid="camera-shutter"
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-pill border-4 border-white/60 bg-surface-raised disabled:opacity-50"
              >
                <span
                  className="h-12 w-12 rounded-pill border-2 border-border-default bg-surface-raised"
                  aria-hidden="true"
                />
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || atMax}
                aria-label={t("camera.gallery")}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-ink-primary text-ink-on-dark disabled:opacity-50"
              >
                <span aria-hidden="true">🖼️</span>
              </button>
            </div>
          </>
        )}

        {/* Busy scrim while the parent runs the quality check + inference. */}
        {disabled && busyLabel && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-design-3 bg-surface-overlay"
            role="status"
            aria-live="polite"
          >
            <span
              className="h-8 w-8 animate-spin rounded-pill border-2 border-border-strong border-t-forest-pale motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-label font-semibold text-ink-on-dark">{busyLabel}</p>
          </div>
        )}
      </div>

      {/* Always mounted: the gallery fallback is the only capture route when `state` is not
          "live", and the officer may prefer it even when it is. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={fileInputTestId}
        onChange={handleFile}
      />

      {/* When there is no live preview the gallery button has no overlay to live in, so it is
          promoted to a full-width control under the panel. */}
      {state !== "live" && state !== "starting" && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || atMax}
          className="min-h-primary-btn w-full rounded-b-md bg-forest text-headline font-semibold text-ink-on-dark disabled:opacity-60"
        >
          {t("camera.gallery")}
        </button>
      )}

      {captureError && (
        <p role="alert" className="px-design-4 pt-design-2 text-caption text-status-error">
          {t("camera.captureError")}
        </p>
      )}
    </div>
  );
}
