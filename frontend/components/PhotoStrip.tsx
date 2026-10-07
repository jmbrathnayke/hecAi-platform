// Captured-photo strip (officer-camera.html mockup screen 2: "3 photos captured" above a row of
// thumbnails, the current one ringed in forest). Extracted from app/officer/classify so the
// officer-assisted submission flow can show the same strip instead of a second copy.
//
// Purely presentational: the host page owns the object URLs and their revocation, because it is
// the one that knows when a case ends. Creating them here would leak a blob per capture for the
// lifetime of the document.
//
// REMOVABLE (2026-10-07). With `onRemove`, every photo carries a remove button: a frame taken by
// accident (a covered lens, a stray tap) could not be taken back out of the case before.
import { X } from "@phosphor-icons/react";

interface PhotoStripProps {
  /** Object URLs, oldest first. The last entry is treated as the current subject. */
  thumbnails: string[];
  /** Pre-formatted count line, e.g. "3 photos captured". */
  countLabel: string;
  /** Accessible name for the list. */
  ariaLabel: string;
  /** Removes the photo at this index. Omitted: the strip is read-only, as before. */
  onRemove?: (index: number) => void;
  /** Accessible name for photo n's remove button (1-based), e.g. "Remove photo 2". */
  removeLabel?: (n: number) => string;
  /** True while a classification or save is in flight, when removing would race it. */
  removeDisabled?: boolean;
}

export function PhotoStrip({
  thumbnails,
  countLabel,
  ariaLabel,
  onRemove,
  removeLabel = (n) => `Remove photo ${n}`,
  removeDisabled = false,
}: PhotoStripProps) {
  if (thumbnails.length === 0) return null;

  return (
    <div data-testid="photo-strip">
      <p className="text-caption font-medium text-ink-secondary">{countLabel}</p>
      <ul aria-label={ariaLabel} className="mt-design-2 flex gap-design-3 overflow-x-auto pb-design-1 pt-design-2 pr-design-2">
        {thumbnails.map((url, i) => (
          <li key={url || `missing-${i}`} className="relative shrink-0">
            {/* Plain <img>: these are blob: object URLs, which next/image cannot optimise, and
                this screen must work fully offline anyway. */}
            {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt=""
              className={`h-16 w-20 rounded-sm border-2 object-cover ${
                i === thumbnails.length - 1 ? "border-forest" : "border-border-default"
              }`}
            />
            ) : (
              // The preview could not be made; the photo still counts and can still be removed.
              <span
                aria-hidden="true"
                className={`block h-16 w-20 rounded-sm border-2 bg-surface-tint ${
                  i === thumbnails.length - 1 ? "border-forest" : "border-border-default"
                }`}
              />
            )}
            {onRemove && (
              // A 40px hit area around a 24px mark, overlapping the photo's corner, so it can be hit
              // with a thumb without covering the picture.
              <button
                type="button"
                onClick={() => onRemove(i)}
                disabled={removeDisabled}
                aria-label={removeLabel(i + 1)}
                data-testid={`photo-remove-${i}`}
                className="absolute -right-3 -top-3 flex h-10 w-10 items-center justify-center rounded-pill disabled:opacity-40"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-pill border-2 border-surface-raised bg-ink-primary text-ink-on-dark shadow-card">
                  <X aria-hidden="true" size={12} weight="bold" />
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
