/**
 * Warm-navigation probe: input to first visual change and to usable, per target and method,
 * plus the back-and-forward scenario (scroll position and router state).
 * Plan rows: section 8 "Board warm navigation" and "Router state"; section 14 "Warm navigation".
 *
 *   node tests/perf/web-app/nav-timing.mjs --label b1-r1 --runs 5 [--profile laptop] [--width 1440]
 *   node tests/perf/web-app/nav-timing.mjs --targets board,issue --methods click,launcher --runs 2
 *
 * Options: --base (default http://127.0.0.1:3192), --seed (tmp/perf/seed-out.json), --label (run),
 * --out (tmp/perf/results), --profile (laptop | desktop | wan | slow; default laptop), --runs (samples
 * per cell, default 5), --targets (board,issue,inbox,dashboard,agent,run,backforward; default all),
 * --methods (click,hover-click,keyboard,launcher; default all), --width (default 1440).
 *
 * A round is one fresh browser context. For each target it loads the target's origin page, makes one
 * unmeasured-as-warm navigation (reported as the `cold-route` cell: the first visit of that route in
 * this page session), then one sample per method, going back to the origin with history.back() after
 * each. Method order rotates per round. Rounds = --runs, so every cell has n = --runs.
 *   input        the click or Enter keydown event's timeStamp (same clock as performance.now())
 *   firstChange  the first DOM mutation inside #main-content after the input (MutationObserver)
 *   usable       the first moment the URL matches the target and #main-content shows the target's text
 *   apiRequests  fetch/xhr requests to /api/ from the input until the network is quiet for 400 ms
 * Methods: click (a plain click), hover-click (pointer over the link, 250 ms, click), keyboard
 * (the link gets focus with locator.focus(), not Tab presses, then Enter), launcher (open it with
 * Meta+K or Control+K, type the name, arrow to the wanted row, time from the Enter).
 *
 * Output (`<out>/<label>-nav-timing.json`):
 *   results[] one per sample { key: "<target>|<method>", firstChangeMs, usableMs, apiRequests, ok }
 *             and per back/forward iteration { key: "backforward|tasks->issue", ... }
 *   rows[]    one per cell { key, target, method, status: ok | not_applicable | failed, reason, n, failed,
 *             median, p75, min, max (usableMs), firstChangeMedian, firstChangeP75, firstChangeMin,
 *             firstChangeMax, apiRequests (median) }
 *             and { key: "backforward|tasks->issue", scrollDeltaPx, stateKept, rightPage, status }
 * The probe reports; gate.mjs decides. It only navigates and reads, but opening an issue makes the app post a
 * "read" marker (POST /api/issues/:id/read), so run it against the local fixture instance only.
 * The back/forward row also reports anchorDeltaPx: how far the clicked row moved on screen after back, which
 * differs from scrollDeltaPx when the list's height changes after the scroll position is restored.
 */
import { chromium } from "@playwright/test";
import {
  fmt,
  isFixtureNoise,
  median,
  parseArgs,
  percentile,
  readSeed,
  spread,
  startMeta,
  writeResult,
} from "./lib/common.mjs";

const args = parseArgs();
const BASE = String(args.base ?? "http://127.0.0.1:3192");
const SEED = readSeed(typeof args.seed === "string" ? args.seed : undefined);
const OUT_DIR = typeof args.out === "string" ? args.out : "tmp/perf/results";
const RUNS = Number(args.runs ?? 5);
const WIDTH = Number(args.width ?? 1440);
const PROFILE_NAME = String(args.profile ?? "laptop");
const P = SEED.prefix;

const PROFILES = {
  desktop: {},
  laptop: { cpu: 1, net: { latency: 40, down: (50 * 1024 * 1024) / 8, up: (10 * 1024 * 1024) / 8 } },
  wan: { cpu: 2, net: { latency: 40, down: (50 * 1024 * 1024) / 8, up: (10 * 1024 * 1024) / 8 } },
  slow: { cpu: 4, net: { latency: 50, down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8 } },
};

const TARGETS = ["board", "issue", "inbox", "dashboard", "agent", "run"];
const METHODS = ["click", "hover-click", "keyboard", "launcher"];
const BACKFORWARD = "backforward";
const BF_KEY = "backforward|tasks->issue";
const BF_SCROLL_OFFSET = 1200;
const READY_TIMEOUT_MS = 60_000;
const HOVER_MS = 250;

const pick = (name, all) => (typeof args[name] === "string" ? String(args[name]).split(",").filter(Boolean) : all);
const WANT_TARGETS = pick("targets", [...TARGETS, BACKFORWARD]);
const WANT_METHODS = pick("methods", METHODS).filter((m) => METHODS.includes(m));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Installed before the app: the input timestamp, the main-region mutation observer and the
 * readiness test. #main-content is the board's scroll container (ui/src/components/Layout.tsx:738).
 */
const INIT_SCRIPT = `(() => {
  const p = (window.__navProbe = { armed: false, input: null, firstChange: null, usable: null, lastMain: 0, spec: null });
  const compile = (s) => ({ path: new RegExp(s.path), text: s.text ? new RegExp(s.text, "i") : null, has: s.has || null });
  const matches = (c) => {
    if (!c.path.test(location.pathname)) return false;
    const main = document.getElementById("main-content");
    if (!main) return false;
    if (c.text && !c.text.test(main.innerText.replace(/\\s+/g, " "))) return false;
    return !c.has || !!document.querySelector(c.has);
  };
  p.test = (s) => matches(compile(s));
  p.arm = (s) => { p.spec = compile(s); p.input = null; p.firstChange = null; p.usable = null; p.armed = true; };
  const check = () => { if (p.input != null && p.usable == null && p.spec && matches(p.spec)) p.usable = performance.now(); };
  const onInput = (e) => {
    if (!p.armed || p.input != null) return;
    if (e.type === "keydown" && e.key !== "Enter") return;
    p.input = e.timeStamp;
    const tick = () => { if (p.usable != null || performance.now() - p.input > 90000) return; check(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  addEventListener("click", onInput, true);
  addEventListener("keydown", onInput, true);
  const host = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const inMain = (n) => { const e = host(n); return !!(e && (e.id === "main-content" || (e.closest && e.closest("#main-content")))); };
  const touchesMain = (r) => inMain(r.target) || Array.prototype.some.call(r.addedNodes, (n) => n.nodeType === 1 && (n.id === "main-content" || n.querySelector("#main-content")));
  new MutationObserver((records) => {
    const now = performance.now();
    if (!records.some(touchesMain)) return;
    p.lastMain = now;
    if (p.input != null && p.firstChange == null) p.firstChange = now;
    check();
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();`;

class NoLink extends Error {}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

async function getJson(route) {
  const res = await fetch(BASE + route);
  if (!res.ok) throw new Error(`GET ${route} -> ${res.status}`);
  return res.json();
}

// Ready texts are matched case-insensitively against #main-content.innerText with whitespace collapsed to single
// spaces, and must not occur on the origin page.
// The dashboard's agent tile shows the fixture's agent count only once its data has loaded.
const DASHBOARD_READY = { path: `^/${P}/dashboard/?$`, text: `${SEED.agentIds.length} Agents Enabled[\\s\\S]*Tasks In Progress` };
const BOARD_READY = { path: `^/${P}/issues/?$`, text: `Backlog \\d+[\\s\\S]*${P}-\\d+` };

/** Resolves every target's origin page, link, ready condition and launcher entry; `na` explains a gap. */
async function resolveTargets() {
  const specs = {
    board: {
      origin: { url: `/${P}/dashboard`, ready: DASHBOARD_READY },
      link: `aside a[href="/${P}/issues"]`,
      ready: BOARD_READY,
      launcher: { query: "Tasks", value: "action:nav.tasks" },
    },
    inbox: {
      origin: { url: `/${P}/dashboard`, ready: DASHBOARD_READY },
      link: `aside a[href="/${P}/inbox"]`,
      ready: { path: `^/${P}/inbox(/mine)?/?$`, text: `Mine[\\s\\S]*${P}-\\d+` },
      launcher: { query: "Inbox", value: "action:nav.inbox" },
    },
    dashboard: {
      origin: { url: `/${P}/issues`, ready: BOARD_READY },
      link: `aside a[href="/${P}/dashboard"]`,
      ready: DASHBOARD_READY,
      launcher: { query: "Dashboard", value: "action:nav.dashboard" },
    },
  };

  const short = SEED.featured?.short;
  if (short) {
    specs.issue = {
      // The task list filtered to the issue, so its row is a link the click methods can use.
      origin: { url: `/${P}/issues?q=${short.identifier}`, ready: { path: `^/${P}/issues/?$`, text: `${esc(short.identifier)}(?!\\d)` } },
      link: `#main-content a[href="/${P}/issues/${short.identifier}"]`,
      // The description, at least one comment (its time of day) and the composer are on screen.
      ready: { path: `^/${P}/issues/${esc(short.identifier)}/?$`, text: `${esc(short.identifier)}[\\s\\S]*Context[\\s\\S]*\\d:\\d\\d [AP]M[\\s\\S]*Message the agent` },
      launcher: { query: short.identifier, value: `issue:${short.id}` },
    };
  } else {
    specs.issue = { na: "seed has no featured.short issue" };
  }

  try {
    const agent = await getJson(`/api/agents/${SEED.agentIds[0]}`);
    if (!agent.urlKey) throw new Error("agent has no urlKey");
    specs.agent = {
      origin: { url: `/${P}/agents/all`, ready: { path: `^/${P}/agents/all/?$`, text: "Agent \\d\\d" } },
      link: `#main-content a[href="/${P}/agents/${agent.urlKey}"]`,
      ready: { path: `^/${P}/agents/${esc(agent.urlKey)}(/.*)?$`, text: `${esc(agent.name)}[\\s\\S]*Identity[\\s\\S]*Capabilities` },
      launcher: { query: agent.name, value: `agent:${agent.id}` },
    };
  } catch (error) {
    specs.agent = { na: `first agent not resolved: ${error.message}` };
  }

  try {
    specs.run = await resolveRun();
  } catch (error) {
    specs.run = { na: `run not resolved: ${error.message}` };
  }
  return specs;
}

/** A run of the featured long issue (the one with the largest log); the latest run of the company otherwise. */
async function resolveRun() {
  let run = null;
  const long = SEED.featured?.long;
  if (long) {
    const runs = await getJson(`/api/issues/${long.identifier}/runs`);
    run = [...runs].sort((a, b) => (b.logBytes ?? 0) - (a.logBytes ?? 0))[0] ?? null;
    if (run) run = { id: run.runId, agentId: run.agentId };
  }
  if (!run) {
    const [latest] = await getJson(`/api/companies/${SEED.companyId}/heartbeat-runs?limit=1`);
    if (latest) run = { id: latest.id, agentId: latest.agentId };
  }
  if (!run) throw new Error("the company has no runs");
  return {
    // The agent's run list; the run's row is a link to the transcript.
    origin: { url: `/${P}/activity/runs?agentId=${run.agentId}`, ready: { path: `^/${P}/activity/runs/?$`, text: "Recent agent executions" } },
    link: `#main-content a[href$="/runs/${run.id}"]`,
    ready: { path: `^/${P}/agents/[^/]+/runs/${esc(run.id)}/?$`, text: "seeded step \\d+" },
    launcher: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------------------------

async function newSession(browser, viewMode, errors) {
  const profile = PROFILES[PROFILE_NAME];
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(INIT_SCRIPT);
  await context.addInitScript(
    ([key, mode]) => {
      try {
        localStorage.setItem(key, JSON.stringify({ viewMode: mode }));
      } catch {}
    },
    [`paperclip:issues-view:${SEED.companyId}`, viewMode],
  );
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !isFixtureNoise(`${m.location().url} ${m.text()}`)) errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  if (profile.net) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.net.latency,
      downloadThroughput: profile.net.down,
      uploadThroughput: profile.net.up,
    });
  }
  return { context, page, net: trackApi(page) };
}

/** Logs every fetch/xhr to /api/ and the ones still in flight. */
function trackApi(page) {
  const net = { log: [], inflight: new Set() };
  const isApi = (req) => {
    if (!["fetch", "xhr"].includes(req.resourceType())) return false;
    try {
      return new URL(req.url()).pathname.startsWith("/api/");
    } catch {
      return false;
    }
  };
  page.on("request", (req) => {
    if (!isApi(req)) return;
    net.log.push({ method: req.method(), path: new URL(req.url()).pathname });
    net.inflight.add(req);
  });
  const done = (req) => net.inflight.delete(req);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return net;
}

const normalizePath = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");

const waitReady = (page, ready, timeout = READY_TIMEOUT_MS) =>
  page.waitForFunction((s) => !!window.__navProbe && window.__navProbe.test(s), ready, { timeout, polling: 50 });

/** True once no API request is in flight and #main-content has not changed for `quietMs`. */
async function waitQuiet(page, net, quietMs = 400, timeoutMs = 20_000) {
  const start = Date.now();
  let calm = 0;
  while (Date.now() - start < timeoutMs) {
    const idle = net.inflight.size === 0 && (await page.evaluate((q) => performance.now() - window.__navProbe.lastMain > q, quietMs));
    calm = idle ? calm + 1 : 0;
    if (calm >= 2) return true;
    await sleep(100);
  }
  return false;
}

async function gotoOrigin(page, net, spec) {
  await page.goto(BASE + spec.origin.url, { waitUntil: "commit" });
  await waitReady(page, spec.origin.ready);
  try {
    await waitReady(page, { ...spec.origin.ready, has: spec.link }, 15_000);
  } catch {
    throw new NoLink(`link ${spec.link} not found on ${spec.origin.url}`);
  }
  await waitQuiet(page, net);
  // The target's text must not already be on the origin page, or "usable" would fire before the route renders.
  if (await page.evaluate((s) => window.__navProbe.test({ ...s, path: ".*" }), spec.ready)) {
    throw new Error(`ready text ${spec.ready.text} also matches the origin page ${spec.origin.url}`);
  }
}

// ---------------------------------------------------------------------------------------------
// One navigation
// ---------------------------------------------------------------------------------------------

/** Arms the input capture and marks where this navigation's API requests start. */
function armProbe(session, ready) {
  session.net.startIndex = session.net.log.length;
  return session.page.evaluate((s) => window.__navProbe.arm(s), ready);
}
const launcherShortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

/** Opens the launcher, types the target's name and moves the selection onto the wanted row. */
async function prepareLauncher(page, launcher) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press(launcherShortcut);
  await page.getByPlaceholder(/Type a command or search/i).waitFor({ state: "visible", timeout: 15_000 });
  await page.keyboard.type(launcher.query, { delay: 20 });
  const wanted = launcher.value.toLowerCase();
  let stable = 0;
  for (let i = 0; i < 60; i += 1) {
    const { want, sel } = await page.evaluate((v) => {
      const items = [...document.querySelectorAll("[cmdk-item]")];
      return {
        want: items.findIndex((el) => (el.getAttribute("data-value") ?? "").toLowerCase() === v),
        sel: items.findIndex((el) => el.getAttribute("aria-selected") === "true"),
      };
    }, wanted);
    if (want >= 0 && want === sel) {
      stable += 1;
      if (stable >= 2) return;
      await sleep(120);
      continue;
    }
    stable = 0;
    if (want < 0) await sleep(150);
    else await page.keyboard.press(want > sel ? "ArrowDown" : "ArrowUp");
  }
  await page.keyboard.press("Escape");
  throw new NoLink(`launcher row ${launcher.value} not selectable`);
}

/** Dispatches the input for `method`, arming the probe immediately before it. */
async function dispatchInput(session, spec, method) {
  const { page } = session;
  if (method === "launcher") {
    await prepareLauncher(page, spec.launcher);
    await armProbe(session, spec.ready);
    await page.keyboard.press("Enter");
    return;
  }
  const link = page.locator(`${spec.link}:visible`).first();
  if ((await link.count()) === 0) throw new NoLink(`link ${spec.link} not visible on the origin page`);
  if (method === "keyboard") {
    await link.focus();
    await armProbe(session, spec.ready);
    await page.keyboard.press("Enter");
    return;
  }
  if (method === "hover-click") {
    await link.hover();
    await sleep(HOVER_MS);
  }
  await link.click({ trial: true });
  await armProbe(session, spec.ready);
  await link.click();
}

/** One navigation from the origin page to the target with `method`; the page returns to the origin. */
async function navigateOnce(session, spec, method) {
  const { page, net } = session;
  await dispatchInput(session, spec, method);
  const apiStart = net.startIndex;
  await page.waitForFunction(() => window.__navProbe.usable != null, null, { timeout: READY_TIMEOUT_MS, polling: 50 });
  const probe = await page.evaluate(() => ({ input: window.__navProbe.input, firstChange: window.__navProbe.firstChange, usable: window.__navProbe.usable }));
  await waitQuiet(page, net);
  const calls = net.log.slice(apiStart).map((c) => `${c.method} ${normalizePath(c.path)}`);
  const usableMs = probe.usable - probe.input;
  const firstChangeMs = Math.min((probe.firstChange ?? probe.usable) - probe.input, usableMs);
  await page.evaluate(() => {
    window.__navProbe.armed = false;
    history.back();
  });
  await waitReady(page, { ...spec.origin.ready, has: spec.link });
  await waitQuiet(page, net);
  return { firstChangeMs, usableMs, apiRequests: calls.length, apiPaths: calls };
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

const classify = (error) => (error instanceof NoLink ? { status: "not_applicable", reason: error.message } : { ok: false, status: "failed", reason: String(error.message ?? error).split("\n")[0].slice(0, 200) });

async function runRound(browser, specs, round, errors) {
  const session = await newSession(browser, "board", errors);
  const results = [];
  const methods = WANT_METHODS.map((_, i) => WANT_METHODS[(i + round) % WANT_METHODS.length]);
  try {
    for (const target of TARGETS.filter((t) => WANT_TARGETS.includes(t))) {
      const spec = specs[target];
      if (spec.na) continue;
      const cells = ["cold-route", ...methods].filter((m) => m !== "launcher" || spec.launcher);
      try {
        await gotoOrigin(session.page, session.net, spec);
      } catch (error) {
        for (const method of cells) results.push({ key: `${target}|${method}`, target, method, round, ...classify(error) });
        continue;
      }
      for (const method of cells) {
        const key = `${target}|${method}`;
        try {
          const sample = await navigateOnce(session, spec, method === "cold-route" ? "click" : method);
          results.push({ key, target, method, round, ...sample, ok: true, status: "ok" });
        } catch (error) {
          results.push({ key, target, method, round, ...classify(error) });
          await gotoOrigin(session.page, session.net, spec).catch(() => {});
        }
        console.error(`[round ${round}] ${key} ${describe(results[results.length - 1])}`);
      }
    }
  } finally {
    await session.context.close();
  }
  return results;
}

const describe = (r) => (r.ok ? `usable=${fmt(r.usableMs)} first=${fmt(r.firstChangeMs)} api=${r.apiRequests}` : `${r.status}: ${r.reason}`);

// ---------------------------------------------------------------------------------------------
// Back and forward
// ---------------------------------------------------------------------------------------------

const LIST_READY = { path: `^/${P}/issues/?$`, text: `${P}-\\d+` };

/** Where the row for `href` sits below the top of #main-content (the visible position), or null if it is not rendered. */
const anchorOffset = (page, href) =>
  page.evaluate((h) => {
    const main = document.getElementById("main-content");
    const a = main && main.querySelector(`a[href="${h}"]`);
    return a ? Math.round(a.getBoundingClientRect().top - main.getBoundingClientRect().top) : null;
  }, href);

const readHistory = (page) =>
  page.evaluate(() => {
    const main = document.getElementById("main-content");
    return { path: location.pathname, scrollTop: main ? main.scrollTop : null, marker: history.state?.usr?.perfMarker === 1, text: main ? main.textContent.slice(0, 20000) : "" };
  });

/**
 * Task list scrolled to a fixed offset, with a marker in history.state.usr (the field that holds React
 * Router's location.state); open an issue, back, forward, back. The list entry was pushed by the sidebar
 * link, which itself carries router state, so the marker is added next to it.
 */
async function runBackForward(browser, errors) {
  const session = await newSession(browser, "list", errors);
  const { page, net } = session;
  const iterations = [];
  try {
    await page.goto(`${BASE}/${P}/dashboard`, { waitUntil: "commit" });
    await waitReady(page, DASHBOARD_READY);
    await waitQuiet(page, net);
    await page.locator(`aside a[href="/${P}/issues"]:visible`).first().click();
    await waitReady(page, LIST_READY);
    await waitQuiet(page, net);
    const scrolled = await page.evaluate((y) => {
      const main = document.getElementById("main-content");
      main.scrollTop = y;
      return main.scrollTop;
    }, BF_SCROLL_OFFSET);
    if (scrolled < BF_SCROLL_OFFSET * 0.9) throw new Error(`task list too short to scroll to ${BF_SCROLL_OFFSET}px (reached ${scrolled})`);
    await sleep(500);
    await page.evaluate(() => history.replaceState({ ...history.state, usr: { ...(history.state?.usr ?? {}), perfMarker: 1 } }, ""));

    for (let i = 0; i < RUNS; i += 1) {
      const before = await readHistory(page);
      const href = await page.evaluate(() => {
        const main = document.getElementById("main-content");
        const box = main.getBoundingClientRect();
        for (const a of main.querySelectorAll("a[href]")) {
          const r = a.getBoundingClientRect();
          if (/\/issues\/[A-Z]+-\d+$/.test(a.getAttribute("href")) && r.top > box.top + 40 && r.bottom < box.bottom - 20) return a.getAttribute("href");
        }
        return null;
      });
      if (!href) throw new Error("no issue link inside the viewport of the scrolled list");
      const identifier = href.split("/").pop();
      const issueReady = { path: `^${esc(href)}/?$`, text: esc(identifier) };
      const anchorBefore = await anchorOffset(page, href);
      await page.locator(`#main-content a[href="${href}"]:visible`).first().click();
      await waitReady(page, issueReady);
      await sleep(300);
      const steps = [];
      for (const [name, action, ready] of [
        ["back1", "back", LIST_READY],
        ["forward", "forward", issueReady],
        ["back2", "back", LIST_READY],
      ]) {
        await page.evaluate((a) => history[a](), action);
        await waitReady(page, ready);
        await sleep(800);
        const now = await readHistory(page);
        const isList = ready === LIST_READY;
        const anchorNow = isList ? await anchorOffset(page, href) : null;
        steps.push({
          step: name,
          url: now.path,
          rightPage: now.path === (isList ? `/${P}/issues` : href) && (isList ? new RegExp(LIST_READY.text, "i").test(now.text) : now.text.includes(identifier)),
          scrollDeltaPx: isList ? Math.abs(now.scrollTop - before.scrollTop) : null,
          anchorDeltaPx: isList && anchorBefore != null && anchorNow != null ? Math.abs(anchorNow - anchorBefore) : null,
          stateKept: isList ? now.marker : null,
        });
      }
      const lists = steps.filter((s) => s.scrollDeltaPx != null);
      const anchors = lists.map((s) => s.anchorDeltaPx).filter((v) => v != null);
      iterations.push({
        key: BF_KEY,
        iteration: i,
        scrollTopBefore: before.scrollTop,
        scrollDeltaPx: Math.max(...lists.map((s) => s.scrollDeltaPx)),
        anchorDeltaPx: anchors.length ? Math.max(...anchors) : null,
        stateKept: lists.every((s) => s.stateKept),
        rightPage: steps.every((s) => s.rightPage),
        steps,
        ok: true,
      });
      console.error(`[backforward] #${i} ${JSON.stringify({ scrollDeltaPx: iterations[i].scrollDeltaPx, stateKept: iterations[i].stateKept, rightPage: iterations[i].rightPage })}`);
    }
  } catch (error) {
    iterations.push({ key: BF_KEY, ok: false, reason: String(error.message ?? error).split("\n")[0].slice(0, 200) });
  } finally {
    await session.context.close();
  }
  return iterations;
}

// ---------------------------------------------------------------------------------------------
// Rows and output
// ---------------------------------------------------------------------------------------------

function cellRows(specs, results) {
  const rows = [];
  for (const target of TARGETS.filter((t) => WANT_TARGETS.includes(t))) {
    for (const method of ["cold-route", ...WANT_METHODS]) {
      const key = `${target}|${method}`;
      const base = { key, target, method };
      if (specs[target].na) {
        rows.push({ ...base, status: "not_applicable", reason: specs[target].na, n: 0 });
        continue;
      }
      if (method === "launcher" && !specs[target].launcher) {
        rows.push({ ...base, status: "not_applicable", reason: "no launcher entry for this target", n: 0 });
        continue;
      }
      const cell = results.filter((r) => r.key === key);
      const good = cell.filter((r) => r.ok);
      const bad = cell.filter((r) => !r.ok);
      const status = good.length ? "ok" : bad.length && bad.every((r) => r.status === "not_applicable") ? "not_applicable" : "failed";
      const usable = good.map((r) => r.usableMs);
      const first = good.map((r) => r.firstChangeMs);
      rows.push({
        ...base,
        status,
        ...(bad.length ? { reason: bad[0].reason } : {}),
        n: good.length,
        failed: bad.filter((r) => r.status === "failed").length,
        median: median(usable),
        p75: percentile(usable, 0.75),
        min: spread(usable).min,
        max: spread(usable).max,
        firstChangeMedian: median(first),
        firstChangeP75: percentile(first, 0.75),
        firstChangeMin: spread(first).min,
        firstChangeMax: spread(first).max,
        apiRequests: median(good.map((r) => r.apiRequests)),
      });
    }
  }
  return rows;
}

function backForwardRow(iterations) {
  const good = iterations.filter((r) => r.ok);
  if (!good.length) return { key: BF_KEY, status: "failed", reason: iterations[0]?.reason ?? "not run", n: 0 };
  return {
    key: BF_KEY,
    status: "ok",
    n: good.length,
    scrollDeltaPx: Math.max(...good.map((r) => r.scrollDeltaPx)),
    anchorDeltaPx: Math.max(...good.map((r) => r.anchorDeltaPx ?? 0)),
    stateKept: good.every((r) => r.stateKept),
    rightPage: good.every((r) => r.rightPage),
  };
}

function printTables(rows) {
  console.log(`\n| target | method | n | usable med | p75 | min | max | first med | first p75 | api | status |`);
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.filter((x) => x.target)) {
    const status = r.status === "ok" ? (r.failed ? `ok (${r.failed} failed)` : "ok") : `${r.status}: ${r.reason ?? ""}`;
    console.log(`| ${r.target} | ${r.method} | ${r.n} | ${fmt(r.median)} | ${fmt(r.p75)} | ${fmt(r.min)} | ${fmt(r.max)} | ${fmt(r.firstChangeMedian)} | ${fmt(r.firstChangeP75)} | ${fmt(r.apiRequests, 1)} | ${status} |`);
  }
  const bf = rows.find((r) => r.key === BF_KEY);
  if (bf) {
    console.log(`\n| scenario | n | scrollDeltaPx | anchorDeltaPx | stateKept | rightPage | status |`);
    console.log("|---|---|---|---|---|---|---|");
    console.log(`| ${bf.key} | ${bf.n} | ${bf.scrollDeltaPx ?? "-"} | ${bf.anchorDeltaPx ?? "-"} | ${bf.stateKept ?? "-"} | ${bf.rightPage ?? "-"} | ${bf.status}${bf.reason ? `: ${bf.reason}` : ""} |`);
  }
}

async function main() {
  if (!PROFILES[PROFILE_NAME]) throw new Error(`unknown --profile ${PROFILE_NAME} (${Object.keys(PROFILES).join(", ")})`);
  const meta = startMeta("nav-timing", { ...args, base: BASE }, {
    profile: PROFILE_NAME,
    runs: RUNS,
    width: WIDTH,
    targets: WANT_TARGETS,
    methods: WANT_METHODS,
    fixture: SEED.counts,
  });
  const specs = await resolveTargets();
  const errors = [];
  const results = [];
  const browser = await chromium.launch({ headless: true });
  try {
    if (WANT_TARGETS.some((t) => TARGETS.includes(t))) {
      for (let round = 0; round < RUNS; round += 1) results.push(...(await runRound(browser, specs, round, errors)));
    }
    if (WANT_TARGETS.includes(BACKFORWARD)) results.push(...(await runBackForward(browser, errors)));
  } finally {
    await browser.close();
  }
  const rows = cellRows(specs, results);
  if (WANT_TARGETS.includes(BACKFORWARD)) rows.push(backForwardRow(results.filter((r) => r.key === BF_KEY)));
  meta.consoleErrors = errors.length;
  meta.consoleErrorSamples = errors.slice(0, 5);
  const file = writeResult(meta, { rows, results }, OUT_DIR);
  printTables(rows);
  console.log(`\nprofile ${PROFILE_NAME}, width ${WIDTH}, load avg ${meta.loadAvgStart.toFixed(1)} -> ${meta.loadAvgEnd.toFixed(1)}, console errors ${errors.length}; results: ${file}`);
}

await main();
