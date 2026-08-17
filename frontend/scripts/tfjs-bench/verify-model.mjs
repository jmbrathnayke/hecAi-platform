/**
 * Numerically verify a converted TF.js model against the Keras model it came from.
 *
 *   node scripts/tfjs-bench/verify-model.mjs --model <dir> --fixtures <dir> [--format graph|layers] [--scale 255]
 *
 * WHY. "The model loaded" is not evidence that it is the same model. A conversion can succeed,
 * load cleanly, and still produce different numbers -- wrong input scaling, a dropped layer, a
 * transposed kernel. Any of those would silently change every classification in the field while
 * every existing test still passed, because lib/__tests__/mobilenet.test.ts mocks @tensorflow/tfjs
 * wholesale and never touches a real weight file.
 *
 * Fixtures come from backend/ml (see the README): real validation images as raw float32 [0,255]
 * plus the Keras model's own probabilities for them. This asserts the browser reproduces those
 * probabilities, not merely that it produces some.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const FRONTEND = resolve(HERE, "..", "..");

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const MODEL = resolve(arg("model", join(FRONTEND, "public", "models", "mobilenetv2")));
const FIXTURES = arg("fixtures") && resolve(arg("fixtures"));
const FORMAT = arg("format", "graph");
const SCALE = Number(arg("scale", "255"));   // divide raw [0,255] by this before predict
const TOL = Number(arg("tol", "1e-3"));

// Smoke mode needs no dataset, so CI can run it: it loads the REAL committed model file in a
// REAL browser and asserts one inference produces the right number of finite probabilities.
// That is the check whose absence let a completely unloadable model ship -- every existing
// test mocks @tensorflow/tfjs, so none of them touches model.json at all.
const SMOKE = process.argv.includes("--smoke");
if (!FIXTURES && !SMOKE) {
  console.error("--fixtures is required (generate with backend/ml: see README), or pass --smoke");
  process.exit(2);
}

// Asserted against the model's real output width, so a converted model that silently changes
// its head (a 2-class or 1001-class output) fails instead of being benchmarked as if fine.
const CLASS_COUNT = JSON.parse(
  await readFile(join(FRONTEND, "public", "models", "mobilenetv2", "class_names.json"), "utf-8"),
).length;

const MIME = { ".json": "application/json", ".bin": "application/octet-stream", ".js": "text/javascript", ".html": "text/html" };
const MOUNTS = [
  ["/vendor/tf.min.js", join(FRONTEND, "node_modules", "@tensorflow", "tfjs", "dist", "tf.min.js")],
  ["/model", MODEL],
  ...(FIXTURES ? [["/fixtures", FIXTURES]] : []),
];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") return res.writeHead(200, { "content-type": "text/html" })
    .end("<!doctype html><meta charset=utf-8><script src=/vendor/tf.min.js></script>");
  let file = null;
  for (const [prefix, target] of MOUNTS) {
    if (p === prefix) { file = target; break; }
    if (!p.startsWith(prefix + "/")) continue;
    const full = normalize(join(target, p.slice(prefix.length + 1)));
    if (full !== target && !full.startsWith(target + sep)) break;
    file = full; break;
  }
  if (!file) return res.writeHead(404).end();
  try {
    const info = await stat(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": info.size });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
let out;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  out = await page.evaluate(async ({ format, scale, tol, smoke, classes }) => {
    const load = format === "graph" ? tf.loadGraphModel : tf.loadLayersModel;
    let model;
    try { model = await load.call(tf, "/model/model.json"); }
    catch (e) { return { loaded: false, error: String(e.message || e) }; }

    if (smoke) {
      const probs = tf.tidy(() => {
        const y = model.predict(tf.zeros([1, 224, 224, 3]));
        return Array.from((Array.isArray(y) ? y[0] : y).dataSync());
      });
      const sum = probs.reduce((a, b) => a + b, 0);
      return {
        loaded: true, smoke: true, backend: tf.getBackend(), tfjs: tf.version.tfjs,
        output_length: probs.length, expected_length: classes,
        all_finite: probs.every(Number.isFinite),
        softmax_sums_to_one: Math.abs(sum - 1) < 1e-3,
        probs: probs.map((p) => +p.toFixed(6)),
        within_tolerance: probs.length === classes && probs.every(Number.isFinite)
          && Math.abs(sum - 1) < 1e-3,
      };
    }

    const expected = await (await fetch("/fixtures/expected.json")).json();
    const raw = new Float32Array(await (await fetch("/fixtures/images_raw255.bin")).arrayBuffer());
    const per = 224 * 224 * 3;
    const rows = [];
    for (let i = 0; i < expected.n; i++) {
      const slice = raw.subarray(i * per, (i + 1) * per);
      const probs = tf.tidy(() => {
        const x = tf.tensor4d(slice, [1, 224, 224, 3]).div(scale);
        const y = model.predict(x);
        return (Array.isArray(y) ? y[0] : y).dataSync();
      });
      const want = expected.mobilenetv2_keras_probs[i];
      const maxDiff = Math.max(...want.map((w, j) => Math.abs(w - probs[j])));
      const argmax = probs.indexOf(Math.max(...probs));
      rows.push({ i, argmax, expected_argmax: expected.mobilenetv2_keras_argmax[i], maxDiff: +maxDiff.toFixed(6) });
    }
    return {
      loaded: true, backend: tf.getBackend(), tfjs: tf.version.tfjs,
      class_names: expected.class_names,
      argmax_agreement: rows.filter((r) => r.argmax === r.expected_argmax).length + "/" + rows.length,
      max_abs_prob_diff: Math.max(...rows.map((r) => r.maxDiff)),
      // Argmax agreement is asserted, not merely reported: the predicted CLASS is what reaches
      // the officer, so a conversion that keeps every probability within tolerance but still
      // flips a decision must fail here rather than be printed and passed over.
      within_tolerance: rows.every((r) => r.maxDiff <= tol && r.argmax === r.expected_argmax),
      rows,
    };
  }, { format: FORMAT, scale: SCALE, tol: TOL, smoke: SMOKE, classes: CLASS_COUNT });
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify(out, null, 2));
if (!out.loaded) { console.error(`\nFAIL: model did not load (${FORMAT} format)`); process.exit(1); }
if (!out.within_tolerance) {
  console.error(SMOKE
    ? "\nFAIL: model loaded but its output is not a valid probability vector"
    : `\nFAIL: probabilities differ by more than ${TOL}`);
  process.exit(1);
}
if (SMOKE) {
  console.log(`\nPASS: ${FORMAT} model loads in a real browser and returns ` +
    `${out.output_length} finite probabilities summing to 1`);
  process.exit(0);
}
console.log(`\nPASS: loaded as ${FORMAT} model, argmax ${out.argmax_agreement}, max |Δp| ${out.max_abs_prob_diff} <= ${TOL}`);
