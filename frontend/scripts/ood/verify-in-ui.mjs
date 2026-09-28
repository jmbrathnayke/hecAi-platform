/**
 * End-to-end proof that the gate is live in the REAL running app, not just in unit tests.
 *
 *   node scripts/ood/verify-in-ui.mjs --base http://localhost:3000 --out <dir> \
 *        --case "<label>=<image path>" [--case ...]
 *
 * Drives /en/model-demo — the same `classifyImage()` the officer pages call — with real image
 * files, reads the rendered verdict, and writes a screenshot per case. A test that mocks
 * @tensorflow/tfjs cannot tell you the deployed weights and the calibrated threshold agree; this
 * can, because it uses both.
 *
 * Exit code 1 if any case's verdict differs from what its label asks for: a label beginning
 * "ood" must be rejected, anything else must be accepted.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://localhost:3000");
const OUT = resolve(arg("out", "scripts/ood/ui-evidence"));

const cases = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--case") {
    const spec = process.argv[++i];
    const eq = spec.indexOf("=");
    cases.push({ label: spec.slice(0, eq), file: resolve(spec.slice(eq + 1)) });
  }
}
if (!cases.length) {
  console.error('usage: --case "<label>=<image>" [--case ...]');
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));

  for (const { label, file } of cases) {
    await page.goto(`${BASE}/en/model-demo`, { waitUntil: "domcontentloaded" });
    await page.setInputFiles('[data-testid="model-demo-input"]', file);
    // Each case reloads the page, so EVERY case pays for the model load and the first inference
    // — and on software WebGL a single MobileNetV2 forward pass is seconds, not milliseconds.
    await page.waitForSelector('[data-testid="demo-result"], [data-testid="demo-error"]', {
      timeout: 180_000,
    });

    const error = await page.locator('[data-testid="demo-error"]').count();
    if (error) {
      const text = await page.locator('[data-testid="demo-error"]').innerText();
      results.push({ label, file, ok: false, error: text.slice(0, 300) });
      continue;
    }

    const rejected = (await page.locator('[data-testid="demo-ood"]').count()) > 0;
    const verdict = await page.locator('[data-testid="demo-result"] > div').first().innerText();
    const distance = await page.locator('[data-testid="demo-distance"]').innerText();
    const raw = rejected ? await page.locator('[data-testid="demo-raw"]').innerText() : null;

    const shot = `${OUT}/${label}.png`;
    await page.locator('[data-testid="demo-result"]').screenshot({ path: shot });

    const expectedReject = label.startsWith("ood");
    results.push({
      label, file, ok: rejected === expectedReject,
      rejected, expectedReject, verdict, distance, raw, screenshot: shot,
    });
  }
} finally {
  await browser.close();
}

for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${r.label.padEnd(22)} ${r.error ?? `${r.verdict} | ${r.distance}`}`);
  if (r.raw) console.log(`      ${r.raw}`);
}
await writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 1));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} as expected -> ${OUT}`);
process.exit(failed.length ? 1 : 0);
