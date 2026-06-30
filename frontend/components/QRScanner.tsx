// Camera-based QR scanner for the public status page (Story 2.5). Loaded via
// `dynamic(() => import(...), { ssr: false })` — camera APIs don't exist on the server
// (CRITICAL #3). On a successful decode it reports the decoded text and stops the camera.
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

interface QRScannerProps {
  onResult: (text: string) => void;
}

export default function QRScanner({ onResult }: QRScannerProps) {
  const t = useTranslations("status");
  const videoRef = useRef<HTMLVideoElement>(null);
  // Keep onResult in a ref so the scanner mounts exactly once (no camera restarts).
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controls: { stop: () => void } | undefined;

    (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        const reader = new BrowserQRCodeReader();
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
          if (result && !cancelled) {
            onResultRef.current(result.getText());
          }
        });
        // If the component unmounted while the camera was starting, the cleanup below
        // already ran (with controls still undefined) — stop the now-live stream here so
        // the camera doesn't keep running with no handle to release it.
        if (cancelled) controls.stop();
      } catch {
        if (!cancelled) setError(t("cameraPermissionDenied"));
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
    // Mount once; onResult is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-caption text-status-error">
        {error}
      </p>
    );
  }

  return (
    <video
      ref={videoRef}
      aria-label={t("scanQR")}
      className="w-full rounded-md border border-border-default"
    />
  );
}
