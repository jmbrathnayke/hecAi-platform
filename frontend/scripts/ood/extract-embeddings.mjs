/**
 * Extract penultimate-layer embeddings from the DEPLOYED TF.js graph, in a real browser,
 * through the EXACT preprocessing lib/mobilenet.ts uses in production.
 *
 *   node scripts/ood/extract-embeddings.mjs --root <label>=<dir> [--root ...] --out <dir>
 *
 * WHY IN A BROWSER, AND WHY THIS GRAPH. The out-of-domain gate is a threshold on a distance
 * measured in feature space. A threshold calibrated on numbers from the Keras model would be
 * calibrated for a *different* pipeline than the one that will enforce it: Keras resizes with
 * tf.image.resize (bilinear, no antialiasing) while the browser resizes with
 * createImageBitmap({resizeQuality:"medium"}) followed by drawImage. Those two produce visibly
 * different 224x224 pixels for the same photo, so they produce different embeddings, so a
 * threshold carried across would be silently mis-set. Extracting here -- same graph, same
 * blobToImageData(), same /255 -- removes that entire class of error.
 *
 * The node read is the global average pool that feeds the classifier's only dense layer, so the
 * distance is measured in exactly the space the model's own decision is linear in.
 *
 * Output: embeddings.bin (float32, n x 1280, row-major) + meta.json (labels, paths, probs).
 * Nothing here is part of the app bundle; this runs offline, by hand, when the gate is
 * recalibrated. Reuses the local-server + Playwright pattern of scripts/tfjs-bench/verify-model.mjs.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const FRONTEND = resolve(HERE, "..", "..");
const MODEL = join(FRONTEND, "public", "models", "mobilenetv2");

/** The 1280-d global-average-pool output; see the module comment. Asserted to exist below. */
const FEATURE_NODE =
  "StatefulPartitionedCall/hec_damage_mobilenetv2_1/global_average_pooling2d_1/Mean";
const SOFTMAX_NODE = "StatefulPartitionedCall/hec_damage_mobilenetv2_1/dense_1/Softmax";
const DIM = 1280;
const INPUT_SIZE = 224;
const BATCH = 25; // images per page.evaluate round-trip -- bounds the JSON payload per call

const args = process.argv.slice(2);
const roots = [];
let OUT = join(HERE, "out");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") {
    const eq = args[++i].indexOf("=");
    roots.push({ label: args[i].slice(0, eq), dir: resolve(args[i].slice(eq + 1)) });
  } else if (args[i] === "--out") {
    OUT = resolve(args[++i]);
  }
}
if (!roots.length) {
  console.error("usage: --root <label>=<dir> [--root ...] [--out <dir>]");
  process.exit(2);
}

// Fail loudly if the graph no longer has the node the gate reads, rather than producing
// embeddings from whatever else the executor happened to resolve.
const graph = JSON.parse(await readFile(join(MODEL, "model.json"), "utf-8"));
const nodeNames = new Set((graph.modelTopology?.node ?? []).map((n) => n.name));
for (const n of [FEATURE_NODE, SOFTMAX_NODE]) {
  if (!nodeNames.has(n)) {
    console.error(`FAIL: node not present in model.json: ${n}`);
    process.exit(1);
  }
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
async function listImages(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listImages(full)));
    else if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

const items = [];
for (const { label, dir } of roots) {
  const files = await listImages(dir);
  for (const f of files) items.push({ label, file: f, url: `/img/${items.length}` });
  console.log(`${label}: ${files.length} images from ${dir}`);
}

const MIME = {
  ".json": "application/json", ".bin": "application/octet-stream",
  ".js": "text/javascript", ".html": "text/html", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp",
};
const MOUNTS = [
  ["/vendor/tf.min.js", join(FRONTEND, "node_modules", "@tensorflow", "tfjs", "dist", "tf.min.js")],
  ["/model", MODEL],
];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") {
    return res.writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><meta charset=utf-8><script src=/vendor/tf.min.js></script>");
  }
  let file = null;
  if (p.startsWith("/img/")) {
    file = items[Number(p.slice(5))]?.file ?? null;
  } else {
    for (const [prefix, target] of MOUNTS) {
      if (p === prefix) { file = target; break; }
      if (!p.startsWith(prefix + "/")) continue;
      const full = normalize(join(target, p.slice(prefix.length + 1)));
      if (full !== target && !full.startsWith(target + sep)) break;
      file = full; break;
    }
  }
  if (!file) return res.writeHead(404).end();
  try {
    const info = await stat(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
    });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const rows = [];
const buf = Buffer.alloc(items.length * DIM * 4);
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`http://127.0.0.1:${port}/`);

  await page.evaluate(async ({ featureNode, softmaxNode }) => {
    await tf.ready();
    window.__model = await tf.loadGraphModel("/model/model.json");
    window.__nodes = [featureNode, softmaxNode];
    // Production's blobToImageData (lib/mobilenet.ts), copied verbatim so the calibration
    // sees the same pixels the officer's device will.
    window.__toImageData = async (blob, size) => {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: size, resizeHeight: size, resizeQuality: "medium",
      });
      try {
        const ctx = new OffscreenCanvas(size, size).getContext("2d");
        ctx.drawImage(bitmap, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size);
      } finally { bitmap.close(); }
    };
  }, { featureNode: FEATURE_NODE, softmaxNode: SOFTMAX_NODE });

  const classNames = JSON.parse(await readFile(join(MODEL, "class_names.json"), "utf-8"));
  await mkdir(OUT, { recursive: true });
  const started = Date.now();

  for (let start = 0; start < items.length; start += BATCH) {
    const urls = items.slice(start, start + BATCH).map((it) => it.url);
    const batch = await page.evaluate(async ({ urls, size }) => {
      // ONE forward pass for the whole batch rather than one per image. Measured on this set
      // under SwiftShader (software WebGL): ~4.7 s/image one at a time, ~3.7 s/image batched —
      // a real but modest gain, because the cost is dominated by software rasterisation of the
      // convolutions, not by kernel launches. The thing that actually makes an interrupted run
      // survivable is the checkpoint below, not this.
      const frames = [];
      const failures = [];
      for (const url of urls) {
        try {
          const blob = await (await fetch(url)).blob();
          frames.push(await window.__toImageData(blob, size));
          failures.push(null);
        } catch (e) {
          frames.push(null);
          failures.push(String(e?.message || e));
        }
      }
      const usable = frames.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
      let feats = [];
      let probs = [];
      if (usable.length) {
        [feats, probs] = tf.tidy(() => {
          const stacked = tf.stack(usable.map((i) => tf.browser.fromPixels(frames[i]).toFloat()));
          const ys = window.__model.execute(stacked.div(255), window.__nodes);
          return [ys[0].arraySync(), ys[1].arraySync()];
        });
      }
      return urls.map((_, k) => {
        const slot = usable.indexOf(k);
        if (slot < 0) return { ok: false, error: failures[k] ?? "decode failed" };
        return { ok: true, feat: feats[slot], probs: probs[slot] };
      });
    }, { urls, size: INPUT_SIZE });

    batch.forEach((r, k) => {
      const i = start + k;
      const it = items[i];
      if (!r.ok) {
        console.error(`  skip ${it.file}: ${r.error}`);
        rows.push({ label: it.label, file: it.file, ok: false });
        return;
      }
      for (let d = 0; d < DIM; d++) buf.writeFloatLE(r.feat[d], (i * DIM + d) * 4);
      rows.push({ label: it.label, file: it.file, ok: true, probs: r.probs });
    });

    // Checkpoint every batch. A long CPU-WebGL run is exactly the kind of job that gets killed
    // (a closed session, the memory reaper), and re-running an hour of inference to recover a
    // file that was never written is avoidable waste.
    const done = Math.min(start + BATCH, items.length);
    await writeFile(join(OUT, "embeddings.bin"), buf);
    await writeFile(join(OUT, "meta.json"), JSON.stringify({
      dim: DIM, n: items.length, complete: done === items.length,
      feature_node: FEATURE_NODE, output_node: SOFTMAX_NODE, class_names: classNames, rows,
    }, null, 1));
    const rate = (Date.now() - started) / done / 1000;
    console.log(`  ${done}/${items.length}  (${rate.toFixed(2)} s/img, ~${Math.round(rate * (items.length - done) / 60)} min left)`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nwrote ${rows.filter((r) => r.ok).length}/${items.length} embeddings -> ${OUT}`);
