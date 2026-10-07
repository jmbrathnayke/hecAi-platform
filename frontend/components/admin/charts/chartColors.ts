// Chart-only color constants (Story 7.1). Recharts fills/strokes need raw hex, not Tailwind
// class names, so these mirror -- but do not literally reuse -- tailwind.config.ts's brand
// colors and statusVocabulary.ts's STATUS_STYLES semantics.
//
// The 5-color status set was run through the dataviz skill's validator
// (`node scripts/validate_palette.js "<hex,...>" --mode light`) as a categorical palette:
//   - STATUS_STYLES' literal `forest` (#2D6A4F) fails the chroma floor as a solid chart fill
//     (it reads as gray at that saturation) -- swapped for the brand's own `forest-mid`
//     (#52B788) for Approved, which passes.
//   - STATUS_STYLES' `ink-secondary` (a muted text tone) has no chart-appropriate categorical
//     equivalent in the existing palette -- Payment Processed uses a new violet not otherwise
//     used in the UI, chosen because every other on-brand hue (blue/orange/green/red) is
//     already spoken for by the other four statuses.
// All 5 passed lightness band, chroma floor, and CVD adjacent-pair separation. Approved
// (#52B788) WARNs on contrast-vs-white-surface (2.41:1) -- per the skill's rule this is not
// dismissable, so StatusBreakdown always pairs every wedge with a visible text legend (never
// color-alone) to satisfy the "visible labels" relief the WARN requires.
//
// This app has no dark theme (no dark tokens in tailwind.config.ts, no theme toggle anywhere
// in the frontend) -- these are light-surface values only; no dark-mode variant needed.
export const STATUS_CHART_COLORS: Record<string, string> = {
  Submitted: "#1565C0", // civic
  "Under Review": "#E76F51", // amber
  Approved: "#52B788", // forest-mid (not forest -- chroma floor)
  Rejected: "#D62828", // status-error
  "Payment Processed": "#7C3AED", // chart-only violet, not elsewhere in the UI
};

export const STATUS_CHART_FALLBACK_COLOR = "#6B7280"; // any status outside the 5 canonical values

// Single-series marks are lone hues, not a categorical set -- the validator's chroma-floor/
// CVD checks are scoped to categorical palettes only (its own documented scope note), so
// these stay the literal brand colors rather than swapped chart variants.
export const VOLUME_TREND_COLOR = "#2D6A4F"; // forest
export const COMPENSATION_COLOR = "#1565C0"; // civic
export const AI_HISTOGRAM_COLOR = "#E76F51"; // amber

export const AXIS_COLOR = "#4A5B52"; // ink-secondary (realigned with tailwind.config.ts, 2026-10-07)
export const GRID_COLOR = "#E3EAE5"; // border-subtle: gridlines are decoration, not content (2026-10-07)
