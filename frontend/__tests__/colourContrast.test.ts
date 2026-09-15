// Enforces the contrast half of NFR-4.2: "The citizen-facing and officer-facing UIs shall meet
// WCAG 2.1 Level AA colour contrast and minimum text size requirements."
//
// WHY THIS EXISTS. That requirement was asserted in the dissertation and reviewed by eye, but
// nothing in the build could fail when a token drifted. A palette is exactly the kind of thing
// that gets adjusted for appearance and silently loses a ratio — the adjustment looks fine to the
// person making it, on a good monitor, indoors. The users this is built for are reading a cheap
// phone in daylight.
//
// WCAG 2.1: 4.5:1 for normal text, 3:1 for large text (>=18.66px bold or >=24px) and for the
// boundaries of user-interface components (1.4.11). The pairs below are the combinations the
// application actually renders, not every possible pairing.
import config from "@/tailwind.config";

const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string>;

function srgb(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum, what renders this way] */
const TEXT_PAIRS: [string, string, number, string][] = [
  ["ink-primary", "surface-base", 4.5, "body text on the page background"],
  ["ink-primary", "surface-raised", 4.5, "body text on a card"],
  ["ink-primary", "surface-tint", 4.5, "body text on a tinted panel"],
  ["ink-secondary", "surface-base", 4.5, "secondary text on the page background"],
  ["ink-secondary", "surface-raised", 4.5, "secondary text on a card"],
  ["ink-on-dark", "forest", 4.5, "label on a primary green button"],
  ["ink-on-amber", "amber", 4.5, "label on the primary call to action"],
  ["ink-on-dark", "civic", 4.5, "label on a civic-blue surface"],
  ["forest", "surface-raised", 4.5, "green text and links on a card"],
  ["forest", "surface-base", 4.5, "green text on the page background"],
  ["forest", "forest-pale", 4.5, "green text on a pale green chip"],
  ["status-error", "status-error-pale", 4.5, "error text on its tint"],
  ["status-error", "surface-raised", 4.5, "error text on a card"],
  ["status-success", "surface-raised", 4.5, "success text on a card"],
  ["civic", "civic-pale", 4.5, "civic text on its tint"],
  ["amber", "amber-pale", 4.5, "under-review chip text on its tint"],
  ["forest", "forest-pale", 4.5, "approved and paid chip text on its tint"],
  ["ink-secondary", "surface-tint", 4.5, "secondary text on a tinted panel"],
];

/** Non-text contrast (WCAG 1.4.11): component boundaries must reach 3:1. */
const UI_PAIRS: [string, string, number, string][] = [
  ["border-strong", "surface-raised", 3, "input and control outlines on a card"],
  ["border-strong", "surface-base", 3, "input and control outlines on the page"],
  ["border-focus", "surface-raised", 3, "focus ring on a card"],
  ["forest", "surface-raised", 3, "filled control against a card"],
];

describe("colour contrast (NFR-4.2, WCAG 2.1 AA)", () => {
  it.each(TEXT_PAIRS)(
    "%s on %s reaches %s:1 — %s",
    (fg, bg, minimum) => {
      expect(colors[fg]).toBeDefined();
      expect(colors[bg]).toBeDefined();
      const ratio = contrast(colors[fg], colors[bg]);
      // Reported to two places so a near-miss is legible in the failure output.
      expect({ pair: `${fg}/${bg}`, ratio: Number(ratio.toFixed(2)) }).toEqual({
        pair: `${fg}/${bg}`,
        ratio: expect.any(Number),
      });
      expect(ratio).toBeGreaterThanOrEqual(minimum);
    },
  );

  it.each(UI_PAIRS)("%s against %s reaches %s:1 — %s", (fg, bg, minimum) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(minimum);
  });

  it("keeps the disabled tone distinguishable from the page without implying it is active", () => {
    // Deliberately NOT required to hit 4.5:1 — disabled text is exempt from 1.4.3, and forcing it
    // to pass would make a disabled control look enabled, which is the worse failure.
    const ratio = contrast(colors["ink-disabled"], colors["surface-base"]);
    expect(ratio).toBeGreaterThanOrEqual(1.8);
    expect(ratio).toBeLessThan(contrast(colors["ink-secondary"], colors["surface-base"]));
  });
});
