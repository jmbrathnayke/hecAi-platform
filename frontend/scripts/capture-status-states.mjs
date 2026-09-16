import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
const OUT = path.resolve("../../system-screenshots");
const BASE = "http://localhost:3000";
mkdirSync(OUT, { recursive: true });
const CASES = [
  ["32-status-si-approved.png", "si", "HEC-2026-0262"],
  ["33-status-paid.png", "en", "HEC-2026-0261"],
  ["34-status-si-paid.png", "si", "HEC-2026-0261"],
];
const b = await chromium.launch();
for (const [file, locale, ref] of CASES) {
  const c = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await c.newPage();
  await p.goto(`${BASE}/${locale}/status`, { waitUntil: "networkidle" });
  await p.waitForSelector("#reference", { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.fill("#reference", ref);
  await p.locator("button").first().click();
  await p.waitForSelector(`text=${ref}`, { timeout: 25000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, file) });
  console.log(`${file}  (${locale}, ${ref})`);
  await c.close();
}
await b.close();
