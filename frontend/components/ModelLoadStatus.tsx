"use client";

// Story 3.2 AC1/AC4. Localized si/ta/en (Story 6.2, FR-9.1) via the officer i18n provider
// (Story 6.1) — strings read from the `officer.modelStatus` namespace.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { loadModel } from "@/lib/mobilenet";

type Status = "idle" | "loading" | "ready" | "error";

export function ModelLoadStatus() {
  const t = useTranslations("officer");
  const [status, setStatus] = useState<Status>("idle");
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;

  // Epic 2 retro lesson: guard state updates after unmount for in-flight async work.
  useEffect(() => {
    let mounted = true;

    const attemptLoad = () => {
      setStatus("loading");
      loadModel()
        .then(() => {
          if (mounted) setStatus("ready");
        })
        .catch((err) => {
          // Log the real cause. The error copy says "not available offline", but this state is
          // reached on ANY load failure — a stale cached model, a bad export, a failed tfjs
          // chunk. Swallowing the cause sent a real investigation down the wrong path: the
          // deployed model.json was in a format TensorFlow.js could not parse, and the UI
          // reported it as a connectivity problem. `cause` carries the underlying tfjs error
          // (see ModelNotAvailableError in lib/mobilenet.ts).
          console.error(
            "[ModelLoadStatus] model failed to load",
            { online: typeof navigator !== "undefined" ? navigator.onLine : null },
            err instanceof Error ? (err.cause ?? err) : err,
          );
          if (mounted) setStatus("error");
        });
    };

    attemptLoad();
    // The error copy tells the officer to reconnect — actually retry on reconnect instead of
    // leaving the error state permanent until a full page reload. Only re-attempt if we're
    // actually in the error state (a "ready" model shouldn't flicker back to "loading").
    const retryOnReconnect = () => {
      if (statusRef.current === "error") attemptLoad();
    };
    window.addEventListener("online", retryOnReconnect);
    return () => {
      mounted = false;
      window.removeEventListener("online", retryOnReconnect);
    };
  }, []);

  if (status === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="model-load-status"
      className={`flex items-center gap-design-2 text-label px-design-4 py-design-2 rounded-md ${
        status === "error" ? "bg-status-error-pale text-status-error" : "bg-forest-pale text-forest"
      }`}
    >
      {status === "loading" && (
        <>
          <span aria-hidden="true" className="animate-spin">
            ⟳
          </span>
          <span>{t("modelStatus.preparing")}</span>
        </>
      )}
      {status === "ready" && (
        <>
          <span aria-hidden="true">✓</span>
          <span>{t("modelStatus.ready")}</span>
        </>
      )}
      {status === "error" && <span>{t("modelStatus.error")}</span>}
    </div>
  );
}
