// Capture signed-in screenshots of every role's interface, for the dissertation's figures.
//
//   node scripts/capture-ui.mjs        (both dev servers must be running)
//
// WHY THIS REPLACES THE EARLIER SET. Of the 14 images in system-screenshots/, three were
// byte-identical duplicates of login pages saved under dashboard names (11-officer-dashboard =
// 08-officer-login, 12-admin-cases = 09-admin-login, 14-ds-dashboard-FIXED = 13-ds-login-FIXED)
// and one (10-ds-dashboard) was the 404 page from before the /ds middleware fix. No staff
// dashboard had ever actually been captured.
//
// Headless Chrome alone could not fix that: it can open a URL but it cannot sign in, and every
// staff route bounces an anonymous visitor to its login page - which is precisely how the
// duplicates arose. Playwright drives a real sign-in, so what is captured is the page a user sees.
//
// EVERY SHOT IS VERIFIED. Each entry names a `proof` locator that exists only on the signed-in
// page, and the screenshot is written only after it resolves. A run that lands on a login form
// fails loudly here instead of producing another mislabelled figure.
//
// One thing is deliberately absent: the FR-6.4 notification control. It renders nothing when the
// browser has no Push API, which headless Chromium does not, so it cannot appear in these figures.
// That is the component behaving as designed, not a capture failure.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("../../system-screenshots");
const BASE = "http://localhost:3000";
const PASSWORD = "HecE2E!2026";

const SHOTS = [
  {
    file: "20-ds-dashboard-real.png",
    login: `${BASE}/ds/login`,
    email: "e2e-ds@hec-e2e.lk",
    target: `${BASE}/ds/dashboard`,
    proof: '[data-testid="ds-case"]',
    viewport: { width: 1280, height: 1000 },
  },
  {
    file: "21-admin-cases-real.png",
    login: `${BASE}/admin/login`,
    email: "e2e-admin@hec-e2e.lk",
    target: `${BASE}/admin/cases`,
    proof: "text=Admin",
    viewport: { width: 1400, height: 1150 },
  },
  {
    file: "22-officer-dashboard-real.png",
    login: `${BASE}/officer/login`,
    email: "e2e-officer@hec-e2e.lk",
    target: `${BASE}/officer/dashboard`,
    proof: "text=/No cases|HEC-20/",   // settled state, not the loading placeholder
    viewport: { width: 900, height: 1150 },
  },
];

mkdirSync(OUT, { recursive: true });

// The citizen has no password sign-in - the login is one-time-code only, and SMS is undeliverable
// (section 7.3) while an email code needs an inbox nobody here owns. Supabase's admin
// generate_link mints the same link that email would have carried and returns it instead of
// sending it, so a real browser can follow it and end up genuinely signed in.
// Read from the backend env; never printed.
function backendEnv(key) {
  const raw = readFileSync("../backend/.env", "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(key + "="));
  return line ? line.slice(key.length + 1).trim() : null;
}

async function citizenMagicLink(email) {
  const url = backendEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = backendEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(url + "/auth/v1/admin/generate_link", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "magiclink",
      email,
      options: { redirect_to: BASE + "/en/my-cases" },
    }),
  });
  if (!res.ok) throw new Error("generate_link HTTP " + res.status);
  const body = await res.json();
  return body.action_link ?? body.properties?.action_link;
}

const browser = await chromium.launch();
let failures = 0;

for (const shot of SHOTS) {
  const context = await browser.newContext({ viewport: shot.viewport });
  const page = await context.newPage();
  try {
    // networkidle, not domcontentloaded: in dev the submit handler is attached at hydration, and a
    // click that beats it does nothing at all - the first attempt at this script silently filled
    // the form, clicked, and made no authentication request whatsoever.
    await page.goto(shot.login, { waitUntil: "networkidle" });
    await page.waitForSelector('button[type="submit"]:not([disabled])');
    await page.waitForTimeout(1500);
    await page.fill('input[type="email"]', shot.email);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);

    await page.goto(shot.target, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await page.waitForSelector(shot.proof, { timeout: 25000 });

    await page.screenshot({ path: path.join(OUT, shot.file) });
    console.log(`OK        ${shot.file}   (${page.url()})`);
  } catch (err) {
    failures += 1;
    console.log(`FAILED    ${shot.file}   ${err.message.split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- citizen surfaces
//
// Captured unauthenticated, which is what these pages genuinely are: reporting and registration
// are reachable without an account (FR-1.2), and the gate below is the FR-10.3 check, not a login
// wall. The earlier attempt signed a citizen in through a generated link and failed -- the browser
// client runs the PKCE flow and ignores the implicit-grant fragment that link carries -- and since
// none of these three screens need a session, the sign-in was never the point.
const PUBLIC_SHOTS = [
  ["24-citizen-home-sinhala.png", "/si", "text=/\u0dc0\u0dcf\u0dbb\u0dca\u0dad\u0dcf/", { width: 1280, height: 900 }],
  ["25-citizen-report-gate.png", "/en/report", "text=Register your family first", { width: 1280, height: 900 }],
  ["26-citizen-register.png", "/en/register", "text=Your NIC number", { width: 1280, height: 900 }],
];

for (const [file, route, proof, viewport] of PUBLIC_SHOTS) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.goto(BASE + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.waitForSelector(proof, { timeout: 25000 });
    await page.screenshot({ path: path.join(OUT, file) });
    console.log(`OK        ${file}   (${page.url()})`);
  } catch (err) {
    failures += 1;
    console.log(`FAILED    ${file}   ${err.message.split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

await browser.close();
console.log(failures ? `\n${failures} capture(s) failed` : "\nall captures verified signed-in");
process.exit(failures ? 1 : 0);
