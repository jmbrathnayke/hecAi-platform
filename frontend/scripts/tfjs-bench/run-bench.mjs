/**
 * RER-6 browser inference latency harness (Story 7.3 code review, decision 2).
 *
 *   node scripts/tfjs-bench/run-bench.mjs [--resnet <dir>] [--out <file>] [--headed]
 *
 * WHY THIS EXISTS. RER-6 requires MobileNetV2 and ResNet-50 to be compared on "classification
 * accuracy and browser inference latency". Accuracy is covered by backend/ml/benchmark_classification.py.
 * Latency was NOT: the figures published there (`inference_ms_per_image`) come from Python/TensorFlow
 * on a desktop CPU, which is a different runtime, a different kernel library and a different numeric
 * path from tfjs in a browser. This drives a real Chromium, loads the real TF.js layers models over
 * real HTTP, and times the real forward pass.
 *
 * WHAT IT MEASURES. Steady-state `model.predict(...)` followed by `.data()` -- the `.data()` is
 * load-bearing, because on the webgl backend `predict` only enqueues work and returns immediately.
 * Model load time and cold-start (first, shader-compiling) inference are reported separately rather
 * than folded in.
 *
 * RESNET IS NOT IN THE REPO, on purpose. It converts to ~95 MB of TF.js shards and anything under
 * frontend/public/ is swept into the service-worker precache and shipped to every field device.
 * Convert it to a scratch directory and pass --resnet; without the flag this benchmarks MobileNetV2
 * alone and says so in the output. See backend/ml/README.md for the conversion command.
 *
 * READ THE CAVEATS in the emitted JSON before citing a number. Headless Chromium here renders WebGL
 * through SwiftShader (software), so the webgl figures are NOT GPU-accelerated timings and are not a
 * phone measurement.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// resolve() strips the trailing separator fileURLToPath leaves on a directory URL. Without it
// the traversal guard below compares against "dir\\" + sep and rejects every legitimate file.
const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const FRONTEND = resolve(HERE, "..", "..");
const REPO = resolve(FRONTEND, "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RESNET_DIR = arg("resnet");
const OUT = resolve(arg("out", join(REPO, "backend", "ml", "results", "browser_latency.json")));
const HEADED = process.argv.includes("--headed");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".bin": "application/octet-stream",
};

// Explicit mount table rather than one document root: the three trees live in unrelated places
// (page here, tfjs in node_modules, models in public/ and possibly a scratch dir).
const MOUNTS = [
  ["/vendor/tf.min.js", join(FRONTEND, "node_modules", "@tensorflow", "tfjs", "dist", "tf.min.js")],
  ["/models/mobilenetv2", join(FRONTEND, "public", "models", "mobilenetv2")],
  ...(RESNET_DIR ? [["/models/resnet50", resolve(RESNET_DIR)]] : []),
  ["/", HERE],
];

function resolveRequest(urlPath) {
  for (const [prefix, target] of MOUNTS) {
    if (urlPath === prefix) return target;
    if (!urlPath.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")) continue;
    const rest = urlPath.slice(prefix.length).replace(/^\//, "");
    // normalize + prefix check: without it a `..` segment in a request path would serve any file
    // on the machine. This server is localhost-only and short-lived, but a directory traversal is
    // not something to leave lying in a repo for someone to copy into a less careful context.
    const full = normalize(join(target, rest));
    if (full !== target && !full.startsWith(target + sep)) return null;
    return full;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = resolveRequest(urlPath === "/" ? "/bench.html" : urlPath);
  if (!file) { res.writeHead(403).end("forbidden"); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": info.size,
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
});

async function dirSize(dir) {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const name of await readdir(dir)) {
    const info = await stat(join(dir, name));
    if (info.isFile()) total += info.size;
  }
  return total;
}

const CONFIG = {
  warmup: 5,
  iterations: 30,
  budgetMs: 120_000,     // per model/backend pair; ResNet on the cpu backend would run for hours
  backends: ["webgl", "cpu"],
  models: [
    // MobileNetV2 is the DEPLOYED file, read straight out of frontend/public -- benchmarking a
    // separately converted copy would risk publishing latency for a model no device runs.
    { key: "mobilenetv2", url: "/models/mobilenetv2/model.json", inputScale: 1, format: "graph" },
    // ResNet-50 keeps preprocess_input inside its graph, so it takes raw [0,255].
    ...(RESNET_DIR
      ? [{ key: "resnet50", url: "/models/resnet50/model.json", inputScale: 255, format: "graph" }]
      : []),
  ],
};

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`serving on http://127.0.0.1:${port}  (resnet: ${RESNET_DIR ?? "not supplied"})`);

const browser = await chromium.launch({
  headless: !HEADED,
  // SwiftShader gives headless Chromium a WebGL context at all. It is SOFTWARE rendering -- the
  // webgl numbers below are therefore not GPU timings. Recorded as a caveat in the output.
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});

let payload;
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [page] ${m.text()}`));
  page.on("pageerror", (e) => console.error(`  [page error] ${e.message}`));
  await page.addInitScript((cfg) => { window.__BENCH_CONFIG__ = cfg; }, CONFIG);
  await page.goto(`http://127.0.0.1:${port}/bench.html`);
  await page.waitForFunction(() => window.__BENCH_DONE__ === true, null, { timeout: 900_000 });
  payload = await page.evaluate(() => window.__BENCH_RESULT__);
} finally {
  await browser.close();
  server.close();
}

if (payload?.fatal) {
  console.error(payload.fatal);
  process.exit(1);
}

payload.measured_at = new Date().toISOString();
payload.platform = `${process.platform} ${process.arch}, node ${process.version}`;
payload.model_bytes = {
  mobilenetv2: await dirSize(join(FRONTEND, "public", "models", "mobilenetv2")),
  ...(RESNET_DIR ? { resnet50: await dirSize(resolve(RESNET_DIR)) } : {}),
};
payload.caveats = [
  "Headless Chromium with SwiftShader: the 'webgl' rows are SOFTWARE-rendered, not GPU timings. " +
    "On a device with a real GPU the webgl figures would improve; the cpu rows would not.",
  "Desktop hardware, not a field device. These are relative-architecture figures, not a claim " +
    "about what a mid-range Android phone achieves.",
  "Steady-state forward pass only. lib/mobilenet.ts::classifyImage additionally decodes and " +
    "resizes the photo, so its reported processingTimeMs is larger by design.",
  "Synthetic input tensor. Latency is data-independent for these architectures, but no claim " +
    "about accuracy can be drawn from this file -- see classification_benchmark.json.",
  ...(RESNET_DIR ? [] : ["ResNet-50 was NOT benchmarked: --resnet was not supplied."]),
];

const { writeFile, mkdir } = await import("node:fs/promises");
await mkdir(resolve(OUT, ".."), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf-8");
console.log(`\nWrote ${OUT}`);
for (const [model, byBackend] of Object.entries(payload.results)) {
  for (const [backend, r] of Object.entries(byBackend)) {
    if (r.inference) {
      console.log(`  ${model.padEnd(12)} ${backend.padEnd(6)} median ${String(r.inference.median_ms).padStart(9)} ms` +
        `  p95 ${String(r.inference.p95_ms).padStart(9)} ms  load ${String(r.load_ms).padStart(9)} ms  n=${r.inference.n}`);
    } else {
      console.log(`  ${model.padEnd(12)} ${backend.padEnd(6)} ${r.skipped ?? r.error}`);
    }
  }
}
