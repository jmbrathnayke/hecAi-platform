// The staff portals' mark: a forest tile with a paw print, then the portal's name. Replaces the 🐘
// emoji the admin, DS and system bars used, which rendered differently on every OS (2026-10-07).
import { PawPrint } from "@phosphor-icons/react";

export function StaffBrandMark({
  label,
  size = "md",
  compact = false,
}: {
  label: string;
  size?: "md" | "lg";
  /** In a top bar on a phone the tile alone carries the brand; the name returns from `sm`. */
  compact?: boolean;
}) {
  const tile = size === "lg" ? "h-10 w-10 text-[22px]" : "h-8 w-8 text-[18px]";
  return (
    <span className="flex min-w-0 items-center gap-design-2">
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-sm bg-forest text-ink-on-dark ${tile}`}
      >
        <PawPrint weight="fill" />
      </span>
      <span
        className={`truncate text-label font-semibold tracking-tight text-ink-primary ${compact ? "sr-only sm:not-sr-only" : ""}`}
      >
        {label}
      </span>
    </span>
  );
}
