// A single captured-photo slot: thumbnail + advisory quality overlay (UX-DR6) +
// remove control. Quality warnings are advisory only — the citizen may keep the photo.
"use client";

interface PhotoThumbnailProps {
  previewUrl: string;
  warningText: string | null; // null when the photo passes quality checks
  retakeLabel: string;
  removeLabel: string;
  onRemove: () => void;
  onRetake: () => void;
}

export function PhotoThumbnail({
  previewUrl,
  warningText,
  retakeLabel,
  removeLabel,
  onRemove,
  onRetake,
}: PhotoThumbnailProps) {
  return (
    <div className="relative aspect-square overflow-hidden rounded-md border border-border-default">
      {/* eslint-disable-next-line @next/next/no-img-element -- object-URL blob preview, not a static asset */}
      <img src={previewUrl} alt="" className="h-full w-full object-cover" />

      {warningText && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-design-1 bg-black/60 p-design-1">
          <span className="text-center text-caption leading-tight text-ink-on-dark">
            {warningText}
          </span>
          <button
            type="button"
            onClick={onRetake}
            className="text-caption font-semibold text-amber underline"
          >
            {retakeLabel}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-caption text-ink-on-dark"
      >
        ×
      </button>
    </div>
  );
}
