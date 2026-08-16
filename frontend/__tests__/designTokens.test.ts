// Guards against a recurring, silent defect class in this codebase: a className that LOOKS like
// a design-system token but was never defined in tailwind.config.ts. Tailwind emits nothing for
// an unknown utility, so nothing fails — the element just renders unstyled, and because preflight
// resets h1-h6 to `font-size/font-weight: inherit`, an undefined type token on a heading makes it
// indistinguishable from body text.
//
// Four instances had already shipped before this test existed:
//   - `text-heading-3`      (5 admin components, Stories 5.4/5.5 — headings rendered as body text)
//   - `text-heading`        (officer dashboard + sync)
//   - `py-design-12`        (officer sync — spacing tops out at design-8)
//   - `bg-status-error-pale` (ModelLoadStatus, SyncQueueItem, sync load-error panel)
//
// Scope is deliberately narrow: only classes that use one of THIS project's token families are
// checked, so ordinary Tailwind utilities (text-center, bg-white/20, border-2…) are ignored and
// this never becomes a general Tailwind linter.

import fs from "node:fs";
import path from "node:path";
import config from "@/tailwind.config";

const extend = (config.theme?.extend ?? {}) as {
  colors?: Record<string, unknown>;
  spacing?: Record<string, unknown>;
  fontSize?: Record<string, unknown>;
  minHeight?: Record<string, unknown>;
};

const colorNames = new Set(Object.keys(extend.colors ?? {}));
const spacingNames = new Set(Object.keys(extend.spacing ?? {}));
const fontSizeNames = new Set(Object.keys(extend.fontSize ?? {}));
const minHeightNames = new Set(Object.keys(extend.minHeight ?? {}));

/** Utility prefixes that can take one of this project's custom colour tokens. */
const COLOR_PREFIXES =
  "text|bg|border|ring|fill|stroke|divide|from|via|to|outline|decoration|placeholder|accent|caret|shadow";

/** A colour token belongs to this project if it starts with one of these families. */
const PROJECT_COLOR_FAMILY = /^(ink-|surface-|status-|border-|forest|civic|amber)/;

/** A type-scale token: the six names in the config, plus anything calling itself a heading. */
const PROJECT_FONT_SIZE = /^(display|title|headline|body|label|caption|heading[\w-]*)$/;

const ROOTS = ["app", "components", "lib"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test files legitimately name tokens in assertions; they are not rendered.
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

interface Offence {
  file: string;
  line: number;
  className: string;
  reason: string;
}

/**
 * Removes comment text from one line, carrying `/* … *\/` state across lines. Returns the code
 * that survives plus whether a block comment is still open on the next line.
 */
function stripComments(line: string, wasOpen: boolean): { text: string; stillOpen: boolean } {
  let rest = line;
  let out = "";
  let open = wasOpen;

  while (rest.length > 0) {
    if (open) {
      const close = rest.indexOf("*/");
      if (close === -1) return { text: out, stillOpen: true };
      rest = rest.slice(close + 2);
      open = false;
      continue;
    }
    const lineComment = rest.indexOf("//");
    const blockOpen = rest.indexOf("/*");
    if (blockOpen !== -1 && (lineComment === -1 || blockOpen < lineComment)) {
      out += rest.slice(0, blockOpen);
      rest = rest.slice(blockOpen + 2);
      open = true;
      continue;
    }
    if (lineComment !== -1) {
      out += rest.slice(0, lineComment);
      return { text: out, stillOpen: false };
    }
    out += rest;
    rest = "";
  }
  return { text: out, stillOpen: open };
}

/** Splits a source line into candidate class tokens, ignoring template-literal interpolations. */
function classTokens(line: string): string[] {
  return line.split(/[\s"'`{}()<>,;=]+/).filter(Boolean);
}

function inspect(token: string): string | null {
  // Strip Tailwind variants (hover:, lg:, print:, motion-reduce:…) and any opacity suffix.
  const bare = token.split(":").pop() ?? token;
  const name = bare.replace(/\/\d+$/, "");

  // Spacing: `px-design-4`, `gap-design-2`, `top-design-3`… any utility taking the scale.
  const spacing = /^[a-z-]+-(design-[\w-]+)$/.exec(name);
  if (spacing && !spacingNames.has(spacing[1])) {
    return `spacing token "${spacing[1]}" is not defined (have: ${[...spacingNames].join(", ")})`;
  }

  // Type scale: `text-headline`, `text-heading-3`…
  const fontSize = /^text-([\w-]+)$/.exec(name);
  if (fontSize && PROJECT_FONT_SIZE.test(fontSize[1]) && !fontSizeNames.has(fontSize[1])) {
    return `font-size token "${fontSize[1]}" is not defined (have: ${[...fontSizeNames].join(", ")})`;
  }

  // Colours: `bg-status-error-pale`, `text-ink-primary`, `border-forest`…
  const color = new RegExp(`^(?:${COLOR_PREFIXES})-([\\w-]+)$`).exec(name);
  if (color && PROJECT_COLOR_FAMILY.test(color[1]) && !colorNames.has(color[1])) {
    return `colour token "${color[1]}" is not defined`;
  }

  // minHeight: `min-h-touch-target`, `min-h-primary-btn`.
  const minHeight = /^min-h-([a-z][\w-]*)$/.exec(name);
  if (minHeight && !minHeightNames.has(minHeight[1]) && !/^\d/.test(minHeight[1])) {
    const builtin = new Set(["full", "screen", "min", "max", "fit", "svh", "lvh", "dvh", "px"]);
    if (!builtin.has(minHeight[1])) {
      return `min-height token "${minHeight[1]}" is not defined`;
    }
  }

  return null;
}

describe("design tokens", () => {
  it("defines every project token the source actually uses", () => {
    const offences: Offence[] = [];

    for (const root of ROOTS) {
      const abs = path.join(process.cwd(), root);
      if (!fs.existsSync(abs)) continue;
      for (const file of sourceFiles(abs)) {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        // Comments in this codebase discuss tokens by name — including the broken ones, in the
        // very comments explaining each fix — so they must be stripped, and the JSX ones
        // ({/* … */}) routinely span several lines.
        let inBlockComment = false;
        lines.forEach((line, i) => {
          const code = stripComments(line, inBlockComment);
          inBlockComment = code.stillOpen;
          for (const token of classTokens(code.text)) {
            const reason = inspect(token);
            if (reason) {
              offences.push({
                file: path.relative(process.cwd(), file),
                line: i + 1,
                className: token,
                reason,
              });
            }
          }
        });
      }
    }

    expect(
      offences.map((o) => `${o.file}:${o.line} — "${o.className}": ${o.reason}`),
    ).toEqual([]);
  });

  it("keeps the type scale that DESIGN.md § Typography specifies", () => {
    // DESIGN.md names exactly these six tiers. `heading-3` is NOT one of them — the admin panels
    // that used it were corrected to `headline` (section/card) and `title` (page/case heading).
    expect([...fontSizeNames].sort()).toEqual(
      ["body", "caption", "display", "headline", "label", "title"].sort(),
    );
  });
});
