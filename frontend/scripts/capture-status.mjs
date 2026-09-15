// Capture the public claim-status page (FR-6.1) in both of its states.
//
//   node scripts/capture-status.mjs [suffix]
//
// Two shots, because the page has two genuinely different jobs: the empty state a citizen arrives
// at, and the result state that answers their question. Judging a redesign on only the first is
// how a search page ends up looking fine and telling you nothing.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("../../system-screenshots");
const BASE = "http://localhost:3000";
const REF = "HEC-2026-0262"; // Approved, carries an amount
const suffix = process.argv[2] ? `-${process.argv[2]}` : "";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

await page.goto(`${BASE}/en/status`, { waitUntil: "networkidle" });
// Wait for the control itself: in dev the first paint can precede hydration, and a fixed delay
// races the compile step that follows an edit.
await page.waitForSelector("#reference", { timeout: 60000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, `30-status-empty${suffix}.png`) });
console.log(`empty  -> 30-status-empty${suffix}.png`);

await page.fill('#reference', REF);
await page.click("button:has-text('Check')");
await page.waitForSelector(`text=${REF}`, { timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, `31-status-result${suffix}.png`) });
console.log(`result -> 31-status-result${suffix}.png`);

await browser.close();
