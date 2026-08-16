import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        "surface-base": "#F2F7F2",
        "surface-raised": "#FFFFFF",
        "surface-tint": "#E8F5E9",
        "surface-overlay": "rgba(0,0,0,0.48)",
        // Brand greens
        forest: "#2D6A4F",
        "forest-mid": "#52B788",
        "forest-pale": "#D8F3DC",
        // Civic blue
        civic: "#1565C0",
        "civic-pale": "#E3F2FD",
        // Warm amber (primary CTA)
        amber: "#E76F51",
        "amber-pale": "#FFF0EB",
        // Text
        "ink-primary": "#1A2E1A",
        "ink-secondary": "#4A5E4A",
        "ink-disabled": "#A0AFA0",
        "ink-on-dark": "#FFFFFF",
        "ink-on-amber": "#FFFFFF",
        // Borders
        "border-default": "#C8DBC8",
        "border-strong": "#8FAF8F",
        "border-focus": "#2D6A4F",
        // Status
        "status-success": "#40916C",
        "status-warning": "#E9C46A",
        "status-error": "#D62828",
        // Error tint. Referenced by ModelLoadStatus, SyncQueueItem and the sync-queue load-error
        // panel since Epic 4, but never defined here — so those surfaces were silently rendering
        // on a transparent background. Chosen so status-error text on it clears 4.5:1 (≈4.6).
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
      fontSize: {
        display: ["28px", { lineHeight: "1.25", fontWeight: "700" }],
        title: ["22px", { lineHeight: "1.3", fontWeight: "700" }],
        headline: ["18px", { lineHeight: "1.4", fontWeight: "600" }],
        body: ["16px", { lineHeight: "1.6", fontWeight: "400" }],
        label: ["14px", { lineHeight: "1.4", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "1.5", fontWeight: "400" }],
      },
      minHeight: {
        "touch-target": "48px",
        "primary-btn": "56px",
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
