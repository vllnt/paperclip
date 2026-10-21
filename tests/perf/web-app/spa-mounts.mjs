/**
 * One SPA root across navigations (plan section 8 row "One SPA root across navigations"; section 3.2).
 *
 *   node tests/perf/web-app/spa-mounts.mjs --label m0b-r1 [--width 1440]
 *
 * Options: --base (default http://127.0.0.1:3192), --seed (tmp/perf/seed-out.json), --label (run),
 * --out (tmp/perf/results), --width (1440).
 *
 * Loads the task board, then makes 20 in-app navigations: sidebar clicks and in-page links across the
 * catch-all routes, plus back and forward. After every step it reads `window.__paperclipPerfMounts`
 * (`{ providers, catchAll }`, written by perf builds from M0b on). A mount counter that goes above 1
 * means the `Providers` tree or the catch-all root was mounted again. A page reload between steps is
 * counted in `reloads` (a marker on `window` disappears).
 *
 * Before M0b the object does not exist: both rows are `not_applicable` ("no mount counters before M0b").
 * Output (`<out>/<label>-spa-mounts.json`): rows[] { key: "providers" | "catchAll", maxCount, navigations,
 * reloads, status: ok | not_applicable | failed, note? } and results[] with the counters after every step.
 * The probe reports; gate.mjs fails when maxCount is above 1. It only navigates and reads, but opening an
 * issue makes the app post a "read" marker, so run it against the local fixture instance only.
 */
import { chromium } from "@playwright/test";
import { isFixtureNoise, parseArgs, readSeed, startMeta, writeResult } from "./lib/common.mjs";

const args = parseArgs();
const BASE = String(args.base ?? "http://127.0.0.1:3192");
const SEED = readSeed(typeof args.seed === "string" ? args.seed : undefined);
const OUT_DIR = typeof args.out === "string" ? args.out : "tmp/perf/results";
const WIDTH = Number(args.width ?? 1440);
const P = SEED.prefix;
const KEYS = ["providers", "catchAll"];
const NAVIGATIONS = 20;
const STEP_TIMEOUT_MS = 60_000;
const SETTLE_MS = 600;

const sidebar = (path) => ({ label: `sidebar ${path}`, selector: `aside a[href="/${P}/${path}"]:visible` });
const ISSUE_LINK = { label: "issue link", selector: `#main-content a[href^="/${P}/issues/${P}-"]:visible` };
const AGENT_LINK = {
  label: "agent link",
  selector: `#main-content a[href^="/${P}/agents/"]:not([href$="/all"]):not([href$="/active"]):not([href$="/paused"]):not([href$="/error"]):not([href$="/new"]):visible`,
};
const BACK = { label: "back", history: "back" };
const FORWARD = { label: "forward", history: "forward" };

/** 20 navigations across the catch-all routes; the board is the starting page. */
const STEPS = [
  sidebar("dashboard"), sidebar("issues"), ISSUE_LINK, BACK, FORWARD, BACK,
  sidebar("inbox"), sidebar("agents"), AGENT_LINK, sidebar("routines"),
  sidebar("issues"), sidebar("dashboard"), sidebar("projects"), sidebar("skills"),
  sidebar("activity"), sidebar("issues"), ISSUE_LINK, BACK, sidebar("agents"), BACK,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readCounters = (page) =>
  page.evaluate(() => ({
    mounts: window.__paperclipPerfMounts ? { ...window.__paperclipPerfMounts } : null,
    sameDocument: window.__spaMountsMarker === 1,
    url: location.pathname + location.search,
  }));

/** Performs one step and waits for the URL to change; returns false when the step cannot run. */
async function runStep(page, step) {
  const before = await page.evaluate(() => location.href);
  if (step.history) {
    await page.evaluate((h) => history[h](), step.history);
  } else {
    const link = page.locator(step.selector).first();
    if ((await link.count()) === 0) return { ok: false, reason: `no ${step.label} on the page` };
    await link.click();
  }
  await page.waitForFunction((from) => location.href !== from, before, { timeout: STEP_TIMEOUT_MS, polling: 50 });
  await page.waitForFunction(() => !!document.getElementById("main-content"), null, { timeout: STEP_TIMEOUT_MS, polling: 50 });
  await sleep(SETTLE_MS);
  return { ok: true };
}

async function main() {
  const meta = startMeta("spa-mounts", { ...args, base: BASE }, { width: WIDTH, navigationsPlanned: NAVIGATIONS });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const results = [];
  let rows;
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript(
      ([key]) => {
        try {
          localStorage.setItem(key, JSON.stringify({ viewMode: "board" }));
        } catch {}
      },
      [`paperclip:issues-view:${SEED.companyId}`],
    );
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" && !isFixtureNoise(`${m.location().url} ${m.text()}`)) errors.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

    await page.goto(`${BASE}/${P}/issues`, { waitUntil: "commit" });
    await page.waitForFunction((id) => new RegExp(`${id}-\\d+`).test(document.getElementById("main-content")?.innerText ?? ""), P, { timeout: STEP_TIMEOUT_MS * 2, polling: 100 });
    await sleep(1500);
    await page.evaluate(() => {
      window.__spaMountsMarker = 1;
    });

    const first = await readCounters(page);
    if (!first.mounts) {
      const note = "no mount counters before M0b";
      rows = KEYS.map((key) => ({ key, status: "not_applicable", note }));
      console.log(`window.__paperclipPerfMounts is absent: ${note}`);
    } else {
      const max = Object.fromEntries(KEYS.map((key) => [key, first.mounts[key] ?? 0]));
      let navigations = 0;
      let reloads = 0;
      const skipped = [];
      results.push({ step: 0, label: "initial load", ...first });
      for (const [index, step] of STEPS.entries()) {
        try {
          const outcome = await runStep(page, step);
          if (!outcome.ok) {
            skipped.push(outcome.reason);
            continue;
          }
        } catch (error) {
          skipped.push(`${step.label}: ${String(error.message ?? error).split("\n")[0].slice(0, 120)}`);
          continue;
        }
        navigations += 1;
        const read = await readCounters(page);
        if (!read.sameDocument) {
          reloads += 1;
          await page.evaluate(() => {
            window.__spaMountsMarker = 1;
          });
        }
        for (const key of KEYS) max[key] = Math.max(max[key], read.mounts?.[key] ?? 0);
        results.push({ step: index + 1, label: step.label, ...read });
        console.error(`[${index + 1}/${STEPS.length}] ${step.label} -> ${read.url} mounts=${JSON.stringify(read.mounts)}${read.sameDocument ? "" : " RELOAD"}`);
      }
      const complete = navigations >= NAVIGATIONS;
      rows = KEYS.map((key) => ({
        key,
        maxCount: max[key],
        navigations,
        reloads,
        status: complete ? "ok" : "failed",
        ...(complete ? {} : { reason: `only ${navigations} of ${NAVIGATIONS} navigations ran: ${skipped.join("; ")}` }),
      }));
    }
    await context.close();
  } finally {
    await browser.close();
  }
  meta.consoleErrors = errors.length;
  const file = writeResult(meta, { rows, results }, OUT_DIR);
  console.log("\n| key | status | maxCount | navigations | reloads |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.key} | ${r.status}${r.note ? ` (${r.note})` : ""}${r.reason ? ` (${r.reason})` : ""} | ${r.maxCount ?? "-"} | ${r.navigations ?? "-"} | ${r.reloads ?? "-"} |`);
  console.log(`\nconsole errors ${errors.length}; results: ${file}`);
}

await main();
