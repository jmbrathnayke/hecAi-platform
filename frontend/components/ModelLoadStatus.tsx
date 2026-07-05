"use client";

// Story 3.2 AC1/AC4. Officer routes are English-only with no next-intl provider (FR-9.3,
// see app/officer/layout.tsx) — strings are hardcoded here rather than pulled from
// messages/en.json, matching the existing officer/login page convention.
import { useEffect, useRef, useState } from "react";
import { loadModel } from "@/lib/mobilenet";

type Status = "idle" | "loading" | "ready" | "error";

export function ModelLoadStatus() {
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
        .catch(() => {
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
          <span>Preparing AI model...</span>
        </>
      )}
      {status === "ready" && (
        <>
          <span aria-hidden="true">✓</span>
          <span>AI model ready for offline classification</span>
        </>
      )}
      {status === "error" && (
        <span>AI model not available offline. Please reconnect to load the model.</span>
      )}
    </div>
  );
}
