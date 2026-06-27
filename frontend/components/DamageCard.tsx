// Single-choice damage-category card (UX-DR4: large tappable target ≥44px).
// Used inside a role="radiogroup"; each card is a role="radio".
import type { ReactNode } from "react";

interface DamageCardProps {
  category: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}

const CATEGORY_ICONS: Record<string, ReactNode> = {
  crop: "🌾",
  property: "🏠",
  combined: "⚡",
  none: "👁",
};

export function DamageCard({ category, label, selected, onSelect }: DamageCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-h-[80px] flex-col items-center justify-center gap-design-2 rounded-lg p-design-4 transition-colors ${
        selected
          ? "border-2 border-forest bg-forest-pale text-forest"
          : "border border-border-default bg-surface-raised text-ink-primary hover:border-forest-mid"
      }`}
    >
      <span className="text-2xl" aria-hidden="true">
        {CATEGORY_ICONS[category] ?? "•"}
      </span>
      <span className="text-center text-label font-medium leading-tight">{label}</span>
    </button>
  );
}
