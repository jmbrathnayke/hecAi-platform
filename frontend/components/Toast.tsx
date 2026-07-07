"use client";

import { useEffect } from "react";

interface ToastProps {
  message: string;
  duration?: number;
  onDismiss: () => void;
}

/**
 * Generic auto-dismissing toast (bottom-center). Fades in; the fade is suppressed
 * under `prefers-reduced-motion: reduce` via the `motion-reduce:animate-none` variant.
 */
export function Toast({ message, duration = 3000, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      className="fixed bottom-design-6 left-1/2 z-[100] -translate-x-1/2 rounded-md bg-status-success px-design-5 py-design-3 text-label text-ink-on-dark shadow-lg animate-fade-in motion-reduce:animate-none"
    >
      {message}
    </div>
  );
}
