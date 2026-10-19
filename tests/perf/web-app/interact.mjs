/**
 * INP probe: scripted, non-mutating interactions with the Event Timing API.
 *
 *   node tests/perf/web-app/interact.mjs --label baseline --profile slow --runs 3
 *
 * Each interaction reports the worst event duration (input delay + processing +
 * presentation delay) among the events it caused.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:3192");
const SEED = JSON.parse(fs.readFileSync(opt("seed", "tmp/perf/seed-out.json"), "utf8"));
const RUNS = Number(opt("runs", 3));
const LABEL = opt("label", "inp");
const PROFILE = opt("profile", "slow");
const ONLY = opt("scenarios", "");
const OUT_DIR = opt("out", "tmp/perf/results");
const P = SEED.prefix;
const viewKey = `paperclip:issues-view:${SEED.companyId}`;

const PROFILES = {
  desktop: {},
  slow: { cpu: 4, net: { latency: 50, down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8 } },
};

const INIT = `(() => {
  window.__events = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__events.push({ n: e.name, s: e.startTime, d: e.duration, i: e.interactionId || 0 }); }).observe({ type: "event", durationThreshold: 16, buffered: true }); } catch {}
})();`;

const SCENARIOS = [
  {
    key: "board",
    url: `/${P}/issues`,
    storage: { [viewKey]: { viewMode: "board" } },
    ready: /PER-\d+/,
    steps: [
      ["type in search", async (page) => { await page.getByPlaceholder(/Search tasks/i).click(); await page.keyboard.type("retry policy", { delay: 90 }); }],
      ["clear search", async (page) => { await page.getByPlaceholder(/Search tasks/i).fill(""); }],
      ["open filter", async (page) => { await page.getByRole("button", { name: /filter/i }).first().click(); }],
      ["close filter", async (page) => { await page.keyboard.press("Escape"); }],
      ["open first card", async (page) => { await page.locator("a[href*='/issues/PER-']").first().click(); }],
    ],
  },
  {
    key: "list",
    url: `/${P}/issues`,
    storage: { [viewKey]: { viewMode: "list" } },
    ready: /PER-\d+/,
    steps: [
      ["type in search", async (page) => { await page.getByPlaceholder(/Search tasks/i).click(); await page.keyboard.type("retry policy", { delay: 90 }); }],
      ["clear search", async (page) => { await page.getByPlaceholder(/Search tasks/i).fill(""); }],
      ["open filter", async (page) => { await page.getByRole("button", { name: /filter/i }).first().click(); }],
      ["close filter", async (page) => { await page.keyboard.press("Escape"); }],
      ["scroll list", async (page) => { await page.mouse.move(700, 500); await page.mouse.wheel(0, 3000); await page.waitForTimeout(400); await page.mouse.wheel(0, 3000); }],
      ["open first row", async (page) => { await page.locator("a[href*='/issues/PER-']").first().click(); }],
    ],
  },
  {
    key: "issue-long",
    url: `/${P}/issues/${SEED.featured.long.identifier}`,
    ready: new RegExp(SEED.featured.long.identifier),
    steps: [
      ["scroll thread up", async (page) => { await page.mouse.move(600, 400); for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, -1500); await page.waitForTimeout(250); } }],
      ["focus composer", async (page) => { await page.locator("[contenteditable='true']").last().click(); }],
      ["type in composer", async (page) => { await page.keyboard.type("looks good to me, shipping", { delay: 70 }); }],
    ],
  },
  {
    key: "dashboard",
    url: `/${P}/dashboard`,
    ready: /Dashboard|Agents|Tasks/,
    steps: [
      ["nav to tasks", async (page) => { await page.getByRole("link", { name: /^Tasks$/ }).first().click(); }],
      ["nav to agents", async (page) => { await page.getByRole("link", { name: /^Agents$/ }).first().click(); }],
    ],
  },
];

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

async function runScenario(browser, scenario) {
  const profile = PROFILES[PROFILE];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(INIT);
  if (scenario.storage) {
    await context.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, JSON.stringify(v));
    }, scenario.storage);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  const cdp = await context.newCDPSession(page);
  if (profile.cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  if (profile.net) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.net.latency, downloadThroughput: profile.net.down, uploadThroughput: profile.net.up });
  }
  await page.goto(BASE + scenario.url, { waitUntil: "commit" });
  await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), scenario.ready.source, { timeout: 90_000 });
  await page.waitForTimeout(4000);

  const out = [];
  for (const [name, action] of scenario.steps) {
    const before = await page.evaluate(() => window.__events.length);
    let failed = null;
    try {
      await action(page);
    } catch (error) {
      failed = String(error).split("\n")[0].slice(0, 160);
    }
    await page.waitForTimeout(900);
    const events = await page.evaluate((from) => window.__events.slice(from), before);
    const durations = events.map((e) => e.d);
    out.push({ step: name, worst: durations.length ? Math.max(...durations) : null, events: events.length, failed });
  }
  const all = await page.evaluate(() => window.__events);
  const byInteraction = new Map();
  for (const e of all) if (e.i) byInteraction.set(e.i, Math.max(byInteraction.get(e.i) ?? 0, e.d));
  const durations = [...byInteraction.values()].sort((a, b) => b - a);
  const inp = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))] : null;
  await context.close();
  return { scenario: scenario.key, inp, interactions: durations.length, steps: out, errors };
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const scenario of SCENARIOS.filter((s) => !ONLY || ONLY.split(",").includes(s.key))) {
    for (let i = 0; i < RUNS; i += 1) {
      const r = await runScenario(browser, scenario);
      results.push(r);
      console.error(`[${PROFILE}] ${scenario.key} #${i} inp=${r.inp == null ? "-" : r.inp.toFixed(0)} interactions=${r.interactions} errors=${r.errors.length}`);
    }
  }
} finally {
  await browser.close();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `inp-${LABEL}-${PROFILE}.json`), JSON.stringify(results, null, 2));
console.log(`\n| scenario | INP (median of ${RUNS}) | step: worst event ms (median) |`);
console.log("|---|---|---|");
for (const key of [...new Set(results.map((r) => r.scenario))]) {
  const rs = results.filter((r) => r.scenario === key);
  const steps = rs[0].steps.map((s, idx) => {
    const m = median(rs.map((r) => r.steps[idx].worst));
    const failed = rs.some((r) => r.steps[idx].failed);
    return `${s.step}: ${m == null ? "-" : m.toFixed(0)}${failed ? " (step failed)" : ""}`;
  });
  console.log(`| ${key} | ${median(rs.map((r) => r.inp))?.toFixed(0) ?? "-"} | ${steps.join("; ")} |`);
}
