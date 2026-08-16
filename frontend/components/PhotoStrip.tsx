// Captured-photo strip (officer-camera.html mockup screen 2: "3 photos captured" above a row of
// thumbnails, the current one ringed in forest). Extracted from app/officer/classify so the
// officer-assisted submission flow can show the same strip instead of a second copy.
//
// Purely presentational: the host page owns the object URLs and their revocation, because it is
// the one that knows when a case ends. Creating them here would leak a blob per capture for the
// lifetime of the document.

interface PhotoStripProps {
  /** Object URLs, oldest first. The last entry is treated as the current subject. */
  thumbnails: string[];
  /** Pre-formatted count line, e.g. "3 photos captured". */
  countLabel: string;
  /** Accessible name for the list. */
  ariaLabel: string;
}

export function PhotoStrip({ thumbnails, countLabel, ariaLabel }: PhotoStripProps) {
  if (thumbnails.length === 0) return null;

  return (
    <div data-testid="photo-strip">
      <p className="text-caption font-medium text-ink-secondary">{countLabel}</p>
      <ul aria-label={ariaLabel} className="mt-design-2 flex gap-design-2 overflow-x-auto pb-design-1">
        {thumbnails.map((url, i) => (
          <li key={url} className="shrink-0">
            {/* Plain <img>: these are blob: object URLs, which next/image cannot optimise, and
                this screen must work fully offline anyway. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              className={`h-16 w-20 rounded-sm border-2 object-cover ${
                i === thumbnails.length - 1 ? "border-forest" : "border-border-default"
              }`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
