import type { Config } from "tailwindcss";

// DESIGN TOKENS.
//
// Refreshed 2026-09-11. Two things happened at once and they are worth separating.
//
// 1. FOUR CONTRAST FAILURES WERE FIXED. NFR-4.2 asserts WCAG 2.1 AA, but nothing in the build
//    could fail when a token drifted, and four pairs did not meet it — measured, not guessed:
//
//        white on amber            3.09:1  (needed 4.5)  <- the PRIMARY call to action
//        status-success on white   3.83:1  (needed 4.5)
//        border-strong on white    2.41:1  (needed 3.0)  <- control outlines, WCAG 1.4.11
//        border-strong on the page 2.23:1  (needed 3.0)
//
//    The amber one mattered most: it is the button on every primary action in the citizen flow.
//    __tests__/colourContrast.test.ts now enforces all of these, so the requirement is checkable
//    rather than asserted.
//
// 2. THE SURFACE TREATMENT WAS MODERNISED. Depth now comes from elevation rather than from a
//    visible outline on every card. The usual way to modernise — thinning every border towards a
//    pale hairline — would have made things WORSE here, because the same token sat on form
//    controls, where a faint outline is both an accessibility failure and a real problem for the
//    intended users: a field officer reading a cheap phone in daylight. So the roles were split:
//
//        border-default  form controls and anything the user must locate to operate   >= 3:1
//        border-subtle   decorative card and panel edges, paired with a shadow        decorative
//
// Text sizes are unchanged. NFR-4.2 covers minimum text size as well as contrast, and a type scale
// is not the part of this that looked dated.
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces. The base was #F2F7F2, a green tint strong enough to read as a colour rather
        // than as paper; softened towards neutral so the green that remains belongs to the brand
        // elements rather than to the background.
        "surface-base": "#F5F8F6",
        "surface-raised": "#FFFFFF",
        "surface-tint": "#E9F3EC",
        "surface-overlay": "rgba(12,26,20,0.55)",
        // Brand greens. `forest` is unchanged: it already cleared AA comfortably (6.39:1 on white)
        // and it is the identity of the product.
        forest: "#2D6A4F",
        "forest-mid": "#40916C",
        "forest-pale": "#D8F3DC",
        // Civic blue
        civic: "#1565C0",
        "civic-pale": "#E3F2FD",
        // Warm terracotta (primary CTA). Was #E76F51, which carried white text at 3.09:1 — the
        // most-pressed button in the application failing AA. Deepened until white clears 4.5:1
        // while keeping the warm tone that distinguishes it from the green brand furniture.
        amber: "#B84A2E",
        "amber-pale": "#FDF0EA",
        // Text
        "ink-primary": "#13251C",
        "ink-secondary": "#4A5B52",
        "ink-disabled": "#9BAAA2",
        "ink-on-dark": "#FFFFFF",
        "ink-on-amber": "#FFFFFF",
        // Borders. See the note above for why these are two different jobs.
        "border-default": "#77957F",
        "border-subtle": "#E3EAE5",
        "border-strong": "#5F7D69",
        "border-focus": "#2D6A4F",
        // Status
        "status-success": "#2E7D5B",
        "status-warning": "#B45309",
        "status-error": "#D62828",
        // Error tint. Chosen so status-error text on it clears 4.5:1 (4.58).
        "status-error-pale": "#FEF2F2",
        "status-pending": "#1565C0",
        "status-processed": "#2D6A4F",
      },
      borderRadius: {
        xs: "4px",
        sm: "8px",
        md: "16px",
        lg: "24px",
        xl: "32px",
        pill: "9999px",
      },
      // Elevation. Two layers per step — a tight contact shadow plus a wider ambient one — because
      // a single large blur reads as a glow rather than as a raised surface. Tinted with the ink
      // colour instead of pure black so the shadow sits in the same colour family as the page.
      boxShadow: {
        card: "0 1px 2px rgba(19,37,28,0.04), 0 2px 8px rgba(19,37,28,0.06)",
        raised: "0 2px 4px rgba(19,37,28,0.05), 0 8px 24px rgba(19,37,28,0.08)",
        overlay: "0 8px 16px rgba(19,37,28,0.10), 0 24px 48px rgba(19,37,28,0.14)",
        focus: "0 0 0 3px rgba(45,106,79,0.28)",
      },
      spacing: {
        "design-1": "4px",
        "design-2": "8px",
        "design-3": "12px",
        "design-4": "16px",
        "design-5": "24px",
        "design-6": "32px",
        "design-7": "48px",
        "design-8": "64px",
      },
      fontFamily: {
        // CSS variables are provided by next/font/google (see app/[locale]/layout.tsx).
        sans: [
          "var(--font-noto-sans)",
          "var(--font-noto-sinhala)",
          "var(--font-noto-tamil)",
          "system-ui",
          "sans-serif",
        ],
      },
      // Sizes are unchanged (NFR-4.2 covers minimum text size). What changed is the setting:
      // headings carry slightly negative tracking and tighter leading, which is most of the
      // difference between a heading that looks typeset and one that looks like large body text.
      // Body, label and caption keep neutral tracking — negative tracking on small text at these
      // sizes costs legibility, and Sinhala and Tamil glyphs need the room.
      fontSize: {
        display: ["28px", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "700" }],
        title: ["22px", { lineHeight: "1.25", letterSpacing: "-0.015em", fontWeight: "700" }],
        headline: ["18px", { lineHeight: "1.35", letterSpacing: "-0.01em", fontWeight: "600" }],
        body: ["16px", { lineHeight: "1.6", fontWeight: "400" }],
        label: ["14px", { lineHeight: "1.4", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "1.5", fontWeight: "400" }],
      },
      minHeight: {
        "touch-target": "48px",
        "primary-btn": "56px",
      },
      transitionDuration: {
        quick: "120ms",
        base: "200ms",
      },
      keyframes: {
        "slide-down": {
          "0%": { transform: "translateY(-100%)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        // Suppressed via the `motion-reduce:animate-none` variant (UX-DR15).
        "slide-down": "slide-down 200ms ease-out",
        "fade-in": "fade-in 200ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
