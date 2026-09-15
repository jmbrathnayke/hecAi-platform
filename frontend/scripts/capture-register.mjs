import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
const OUT = path.resolve("../../system-screenshots");
const BASE = "http://localhost:3000";
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();

// step 1, with a field focused so the new focus ring is visible in the figure
{
  const c = await b.newContext({ viewport: { width: 1280, height: 950 } });
  const p = await c.newPage();
  await p.goto(`${BASE}/en/register`, { waitUntil: "networkidle" });
  await p.waitForSelector("#registrant-nic", { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.focus("#registrant-nic");
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, "38-register-step1.png") });
  console.log("38-register-step1.png (step 1, field focused)");
  await c.close();
}

// step 4 — walk forward so the bank step and its notice are reachable
{
  const c = await b.newContext({ viewport: { width: 1280, height: 1100 } });
  const p = await c.newPage();
  await p.goto(`${BASE}/en/register`, { waitUntil: "networkidle" });
  await p.waitForSelector("#registrant-nic", { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.fill("#registrant-nic", "912345678V");
  await p.fill("#registrant-name", "Kamal Silva");
  await p.click("button:has-text('Next')");
  await p.waitForTimeout(700);
  await p.click("button:has-text('Next')");          // family step: none added
  await p.waitForTimeout(700);
  const sel = await p.locator("select").count();
  if (sel >= 2) {
    await p.locator("select").first().selectOption({ index: 1 });
    await p.waitForTimeout(500);
    await p.locator("select").nth(1).selectOption({ index: 1 });
    await p.waitForTimeout(400);
  }
  await p.click("button:has-text('Next')");
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.join(OUT, "39-register-step4.png") });
  console.log("39-register-step4.png (bank step)");
  await c.close();
}
await b.close();
