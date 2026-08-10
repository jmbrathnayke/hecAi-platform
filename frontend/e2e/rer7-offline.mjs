/**
 * RER-7: offline submission completion rate under three network conditions.
 *
 * WHAT THIS EVIDENCES, PRECISELY. Of N cases queued by the PWA under a given network
 * condition, how many are confirmed by the server with a canonical_id once connectivity
 * allows. That is the submission completion rate RER-7 asks for, measured in a real Chromium
 * with a real IndexedDB and real network control -- the half the backend scenario suite
 * (tests/scenarios/) provably cannot reach, since a Flask test client has no service worker.
 *
 * WHAT IT DOES NOT EVIDENCE. It drives lib/syncQueue.ts through app/rer7-harness, not the
 * citizen form. It shows a queued case survives disconnection and lands server-side; it does
 * not show a user can complete the form. Do not report it as the whole of RER-7.
 *
 * PREREQUISITES
 *   backend:  flask running on --api  (default http://127.0.0.1:5055)
 *   frontend: next running on --app   (default http://127.0.0.1:3055) built or dev-served with
 *             NEXT_PUBLIC_ENABLE_RER7_HARNESS=1 and NEXT_PUBLIC_API_URL pointing at --api
 *   env:      SUPABASE_JWT_SECRET (same value the backend was started with)
 *
 * RUN
 *   node e2e/rer7-offline.mjs
 *   node e2e/rer7-offline.mjs --cases 20 --headed --report rer7-report.json
 *
 * CLEANUP. Every case it creates carries offline_id + a `rer7-` actor and is left in the
 * database -- deleting audit rows would break the hash chain (see clear_research_data.py).
 * Point --api at a scratch database, not one holding results you care about.
 */
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const API = opt("api", "http://127.0.0.1:5055");
const APP = opt("app", "http://127.0.0.1:3055");
const CASES_PER_CONDITION = Number(opt("cases", "12"));
const REPORT_PATH = opt("report", null);
const HEADED = flag("headed");
const SECRET = process.env.SUPABASE_JWT_SECRET;

// RER-7's acceptance bar.
const TARGET_RATE = 0.95;

const DISTRICT = "අනුරාධපුරය";
const DIVISION = "ඉපලෝගම";

if (!SECRET) {
  console.error("ERROR: SUPABASE_JWT_SECRET is not set (must match the backend's value).");
  process.exit(2);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mint the officer token /api/v1/sync/batch requires. Role lives in app_metadata, not
 *  user_metadata -- see backend middleware/auth.py (2026-08-11). A token built the old way is
 *  now rejected with 403, which would look like a completion-rate failure rather than a
 *  harness bug, so this is worth stating. */
function mintOfficerToken(sub) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub,
      app_metadata: { role: "officer", assigned_divisions: [DIVISION] },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const casePayload = (offlineId) => ({
  offline_id: offlineId,
  damage_category: "property",
  district: DISTRICT,
  ds_division: DIVISION,
  ai_severity: "Moderate",
  locale: "si",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mint the admin token the read-only verification lookup requires. */
function mintAdminToken() {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: `rer7-admin-${randomUUID().slice(0, 8)}`,
      app_metadata: { role: "admin", district_id: DISTRICT },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/** Ask the SERVER, not the browser, whether each case arrived. The queue deleting its own row
 *  is the PWA's opinion of success; only the API confirms it, and checking IndexedDB alone
 *  would let a client that silently dropped items score 100%.
 *
 *  READ-ONLY BY CONSTRUCTION. The obvious probe -- replaying the batch and reading `inserted`
 *  -- is a WRITE: every unconfirmed case it asks about, it creates. The first version did that,
 *  and a run where the PWA delivered nothing still left a full set of phantom cases in the
 *  database, indistinguishable afterwards from real submissions and counted by the analytics
 *  surfaces. GET /admin/cases/<offline_id> answers the same question without that side effect.
 *  (It still writes an access-audit row per read, which is by design -- FR-5.5 audits reads.) */
async function confirmedServerSide(offlineIds) {
  const adminToken = mintAdminToken();
  const confirmed = new Set();
  for (const offlineId of offlineIds) {
    const res = await fetch(`${API}/api/v1/admin/cases/${offlineId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.status === 200) confirmed.add(offlineId);
    else if (res.status !== 404) {
      throw new Error(`verification lookup failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
  return confirmed;
}

async function openHarness(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("  [page error]", e.message));

  // The clock MUST be installed before fastForward() will do anything -- without it the call is
  // a silent no-op, next_attempt_at never comes due, and runSync correctly finds nothing to
  // send. That reads as a 0% completion rate, i.e. a harness bug indistinguishable from a real
  // PWA failure. (It did exactly that on the first run.)
  //
  // Compressing time is legitimate here, not a shortcut: lib/syncQueue.ts backs off
  // 30/60/120/240/480s, and reconnecting does NOT bypass that window -- runSync filters on
  // next_attempt_at <= now, so a real user really does wait. Fast-forwarding reproduces the
  // wait without spending it. Every POST the harness counts is a real request.
  await page.clock.install();

  await page.goto(`${APP}/rer7-harness`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__hecRer7?.ready === true, { timeout: 30_000 });
  return page;
}

/** Drive one condition and return its measured rate. */
async function runCondition({ browser, name, describe, drive }) {
  const context = await browser.newContext();
  const page = await openHarness(context);
  const token = mintOfficerToken(`rer7-officer-${randomUUID().slice(0, 8)}`);
  const ids = Array.from({ length: CASES_PER_CONDITION }, () => randomUUID());

  console.log(`\n--- ${name} ---\n  ${describe}`);
  const started = Date.now();
  await drive({ page, context, token, ids });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const queueLeft = await page.evaluate(() => window.__hecRer7.queueLength());
  await context.close();

  const confirmed = await confirmedServerSide(ids);
  const rate = confirmed.size / ids.length;
  const pass = rate >= TARGET_RATE;

  console.log(
    `  submitted=${ids.length}  confirmed=${confirmed.size}  ` +
      `rate=${(rate * 100).toFixed(1)}%  queue_remaining=${queueLeft}  ${elapsed}s  ` +
      `${pass ? "PASS" : "FAIL"}`,
  );
  if (!pass) {
    const missing = ids.filter((id) => !confirmed.has(id));
    console.log(`  unconfirmed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}`);
  }

  return {
    condition: name,
    description: describe,
    submitted: ids.length,
    confirmed: confirmed.size,
    rate,
    queue_remaining: queueLeft,
    seconds: Number(elapsed),
    pass,
  };
}

async function main() {
  console.log(`RER-7 offline completion measurement`);
  console.log(`  app=${APP}  api=${API}  cases/condition=${CASES_PER_CONDITION}  target>=${TARGET_RATE * 100}%`);

  const browser = await chromium.launch({ headless: !HEADED });
  const results = [];

  try {
    // Condition 1: fully offline while queuing, then reconnected.
    results.push(
      await runCondition({
        browser,
        name: "offline",
        describe: "queue every case with the network down, then reconnect and flush",
        drive: async ({ page, context, token, ids }) => {
          await context.setOffline(true);
          for (const id of ids) {
            await page.evaluate(
              ([offlineId, payload]) => window.__hecRer7.enqueue(offlineId, payload),
              [id, casePayload(id)],
            );
          }
          // Prove the queue actually holds them BEFORE reconnecting. Without this, a build
          // where enqueue silently no-opped would still "pass" after the flush below.
          const queued = await page.evaluate(() => window.__hecRer7.queueLength());
          if (queued < ids.length) {
            throw new Error(`only ${queued}/${ids.length} reached the queue while offline`);
          }
          // A sync attempt while still offline must fail and leave the items queued.
          await page.evaluate((t) => window.__hecRer7.sync(t), token);
          await context.setOffline(false);
          // First attempt after a failure is 30s out (BASE_BACKOFF_MS in lib/syncQueue.ts).
          await page.clock.fastForward("00:31");
          await page.evaluate((t) => window.__hecRer7.sync(t), token);
          await sleep(1500);
        },
      }),
    );

    // Condition 2: connectivity dropping in and out mid-flush.
    results.push(
      await runCondition({
        browser,
        name: "intermittent",
        describe: "connection flapping offline/online across repeated flush attempts",
        drive: async ({ page, context, token, ids }) => {
          await context.setOffline(true);
          for (const id of ids) {
            await page.evaluate(
              ([offlineId, payload]) => window.__hecRer7.enqueue(offlineId, payload),
              [id, casePayload(id)],
            );
          }
          for (let cycle = 0; cycle < 6; cycle++) {
            await context.setOffline(cycle % 2 === 0);
            await page.evaluate((t) => window.__hecRer7.sync(t), token);
            await sleep(400);
            // Each failed cycle doubles the backoff; jump past it rather than waiting
            // 30/60/120/240s in real time. This compresses time, it does not skip retries --
            // every attempt below is a real POST.
            await page.clock.fastForward(`00:0${Math.min(9, cycle + 1)}:00`);
          }
          await context.setOffline(false);
          await page.evaluate((t) => window.__hecRer7.sync(t), token);
          await sleep(1500);
        },
      }),
    );

    // Condition 3: online but on a slow, high-latency link.
    results.push(
      await runCondition({
        browser,
        name: "slow-2g",
        describe: "online throughout on a throttled 2G-class link (~50 kbps, 2s RTT)",
        drive: async ({ page, context, token, ids }) => {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 2000,
            downloadThroughput: (50 * 1024) / 8,
            uploadThroughput: (20 * 1024) / 8,
          });
          for (const id of ids) {
            await page.evaluate(
              ([offlineId, payload]) => window.__hecRer7.enqueue(offlineId, payload),
              [id, casePayload(id)],
            );
          }
          await page.evaluate((t) => window.__hecRer7.sync(t), token);
          // Generous: one batch over a 2s-RTT link, plus room for a backoff retry.
          for (let i = 0; i < 4; i++) {
            await sleep(3000);
            await page.clock.fastForward("00:31");
            await page.evaluate((t) => window.__hecRer7.sync(t), token);
          }
          await sleep(2000);
        },
      }),
    );
  } finally {
    await browser.close();
  }

  const overallSubmitted = results.reduce((n, r) => n + r.submitted, 0);
  const overallConfirmed = results.reduce((n, r) => n + r.confirmed, 0);
  const overallRate = overallConfirmed / overallSubmitted;
  const allPass = results.every((r) => r.pass);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`RER-7 SUMMARY`);
  console.log(`${"=".repeat(72)}`);
  for (const r of results) {
    console.log(
      `  ${r.condition.padEnd(14)} ${String(r.confirmed).padStart(3)}/${String(r.submitted).padEnd(3)} ` +
        `${(r.rate * 100).toFixed(1).padStart(6)}%  ${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(
    `  ${"OVERALL".padEnd(14)} ${String(overallConfirmed).padStart(3)}/${String(overallSubmitted).padEnd(3)} ` +
      `${(overallRate * 100).toFixed(1).padStart(6)}%  ${allPass ? "PASS" : "FAIL"}`,
  );
  console.log(
    `\n  Scope: measures the queue->server path, not the citizen form UI. See the header comment.`,
  );

  if (REPORT_PATH) {
    writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          target_rate: TARGET_RATE,
          app: APP,
          api: API,
          scope:
            "PWA sync queue -> server confirmation. Excludes the citizen form UI; drives " +
            "lib/syncQueue.ts via app/rer7-harness in real Chromium with real IndexedDB.",
          conditions: results,
          overall: { submitted: overallSubmitted, confirmed: overallConfirmed, rate: overallRate, pass: allPass },
        },
        null,
        2,
      ),
    );
    console.log(`\n  Report written to ${REPORT_PATH}`);
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHarness error:", err);
  process.exit(2);
});
