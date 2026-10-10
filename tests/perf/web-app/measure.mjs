/**
 * Board UI performance baseline: Core Web Vitals, TTI/TBT, requests and API latency per page.
 *
 * Usage (server on :3192 seeded by make-fixture.mjs):
 *   node tests/perf/web-app/measure.mjs --label baseline --runs 5 --profiles desktop,slow
 *   node tests/perf/web-app/measure.mjs --pages tasks-board --profiles slow --runs 3
 *
 * Every run uses a fresh browser context (cold HTTP cache, no service worker),
 * throttles CPU/network over CDP, and reports medians across runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? "http://127.0.0.1:3192";
const SEED = JSON.parse(fs.readFileSync(args.seed ?? "tmp/perf/seed-out.json", "utf8"));
const RUNS = Number(args.runs ?? 3);
const LABEL = args.label ?? "run";
const OUT_DIR = args.out ?? "tmp/perf/results";
const PREFIX = SEED.prefix;

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  wan: {
    viewport: { width: 1440, height: 900 },
    cpu: 2,
    net: { latency: 40, down: (50 * 1024 * 1024) / 8, up: (10 * 1024 * 1024) / 8 },
  },
  slow: {
    viewport: { width: 1440, height: 900 },
    cpu: 4,
    net: { latency: 50, down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8 },
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    mobile: true,
    cpu: 4,
    net: { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (0.75 * 1024 * 1024) / 8 },
  },
};

const viewKey = `paperclip:issues-view:${SEED.companyId}`;
const PAGES = [
  { key: "dashboard", url: `/${PREFIX}/dashboard` },
  { key: "tasks-list", url: `/${PREFIX}/issues`, storage: { [viewKey]: { viewMode: "list" } }, readyText: /PER-\d+/ },
  { key: "tasks-board", url: `/${PREFIX}/issues`, storage: { [viewKey]: { viewMode: "board" } }, readyText: /PER-\d+/ },
  { key: "issue-long", url: `/${PREFIX}/issues/${SEED.featured.long.identifier}`, readyText: new RegExp(SEED.featured.long.identifier) },
  { key: "issue-short", url: `/${PREFIX}/issues/${SEED.featured.short.identifier}`, readyText: new RegExp(SEED.featured.short.identifier) },
  { key: "agents", url: `/${PREFIX}/agents/all`, readyText: /Agent \d\d/ },
  { key: "routines", url: `/${PREFIX}/routines` },
  { key: "costs", url: `/${PREFIX}/costs` },
  { key: "audit", url: `/${PREFIX}/company/activity` },
  { key: "settings", url: `/${PREFIX}/company/settings` },
];

const INIT_SCRIPT = `(() => {
  const p = (window.__perf = { fcp: null, lcp: null, lcpInfo: null, shifts: [], longTasks: [], events: [], lastMutation: 0 });
  const obs = (type, extra, cb) => { try { new PerformanceObserver(cb).observe({ type, buffered: true, ...extra }); } catch {} };
  obs("paint", {}, (l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") p.fcp = e.startTime; });
  obs("largest-contentful-paint", {}, (l) => { const es = l.getEntries(); const e = es[es.length - 1]; p.lcp = e.startTime; p.lcpInfo = { tag: e.element ? e.element.tagName : null, size: e.size, url: e.url || null }; });
  obs("layout-shift", {}, (l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) p.shifts.push({ t: e.startTime, v: e.value, src: (e.sources || []).slice(0, 2).map((s) => s.node ? (s.node.nodeName + "." + String(s.node.className || "").slice(0, 70)) : "?") }); });
  obs("longtask", {}, (l) => { for (const e of l.getEntries()) p.longTasks.push({ s: e.startTime, d: e.duration }); });
  obs("event", { durationThreshold: 16 }, (l) => { for (const e of l.getEntries()) p.events.push({ n: e.name, s: e.startTime, d: e.duration, i: e.interactionId || 0 }); });
  const mo = new MutationObserver(() => { p.lastMutation = performance.now(); });
  const start = () => mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
})();`;

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith("--")) out[list[i].slice(2)] = list[i + 1]?.startsWith("--") || list[i + 1] === undefined ? true : list[++i];
  }
  return out;
}

const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const percentile = (xs, q) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
};

function normalizeRoute(rawUrl) {
  const u = new URL(rawUrl);
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  const p = u.pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")
    .replace(/\/[A-Z]{2,6}-\d+(?=\/|$)/g, "/:identifier")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
  return keys.length ? `${p}?${keys.join("&")}` : p;
}

function computeCls(shifts) {
  let max = 0;
  let cur = 0;
  let first = 0;
  let prev = 0;
  let open = false;
  for (const s of shifts) {
    if (open && (s.t - prev > 1000 || s.t - first > 5000)) open = false;
    if (!open) {
      open = true;
      cur = 0;
      first = s.t;
    }
    cur += s.v;
    prev = s.t;
    max = Math.max(max, cur);
  }
  return max;
}

function busyNetworkIntervals(reqs, t0) {
  const edges = [];
  for (const r of reqs) {
    if (!["Fetch", "XHR", "Script", "Stylesheet", "Document", "Image", "Font", "Other"].includes(r.type) || r.t1 == null) continue;
    edges.push([(r.t0 - t0) * 1000, 1], [(r.t1 - t0) * 1000, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let inflight = 0;
  let busyFrom = null;
  for (const [t, d] of edges) {
    inflight += d;
    if (inflight > 2 && busyFrom == null) busyFrom = t;
    if (inflight <= 2 && busyFrom != null) {
      out.push({ s: busyFrom, e: t });
      busyFrom = null;
    }
  }
  return out;
}

function computeTti(fcp, longTasks, busy) {
  if (fcp == null) return null;
  const blockers = [...longTasks.map((t) => ({ s: t.s, e: t.s + t.d })), ...busy].filter((b) => b.e > fcp).sort((a, b) => a.s - b.s);
  let cand = fcp;
  for (const b of blockers) {
    if (b.s - cand >= 5000) break;
    cand = Math.max(cand, b.e);
  }
  return cand;
}

function computeInp(events) {
  const byInteraction = new Map();
  for (const e of events) {
    if (!e.i) continue;
    byInteraction.set(e.i, Math.max(byInteraction.get(e.i) ?? 0, e.d));
  }
  const durations = [...byInteraction.values()].sort((a, b) => b - a);
  if (!durations.length) return null;
  return durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))];
}

async function measureRun(browser, spec, profileName, runIndex) {
  const profile = PROFILES[profileName];
  const context = await browser.newContext({
    viewport: profile.viewport,
    isMobile: profile.mobile ?? false,
    hasTouch: profile.mobile ?? false,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(INIT_SCRIPT);
  if (spec.storage) {
    await context.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) {
        try {
          localStorage.setItem(k, JSON.stringify(v));
        } catch {}
      }
    }, spec.storage);
  }
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (profile.cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  if (profile.net) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.net.latency,
      downloadThroughput: profile.net.down,
      uploadThroughput: profile.net.up,
    });
  }

  const reqs = new Map();
  const ws = { frames: 0, bytes: 0 };
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!reqs.has(e.requestId)) reqs.set(e.requestId, { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, t0: e.timestamp });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.mime = e.response.mimeType;
    r.serverTiming = e.response.headers["server-timing"] ?? null;
    const t = e.response.timing;
    r.ttfb = t && t.receiveHeadersEnd >= 0 ? t.receiveHeadersEnd - Math.max(0, t.sendEnd) : null;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.t1 = e.timestamp;
      r.bytes = e.encodedDataLength;
    }
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.t1 = e.timestamp;
  });
  for (const ev of ["Network.webSocketFrameReceived", "Network.webSocketFrameSent"]) {
    cdp.on(ev, (e) => {
      ws.frames += 1;
      ws.bytes += e.response?.payloadData?.length ?? 0;
    });
  }

  const target = BASE + spec.url;
  await page.goto(target, { waitUntil: "commit" });

  const deadline = Date.now() + (profileName === "desktop" ? 45_000 : 90_000);
  let settledAt = null;
  let quietSince = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(150);
    const inflight = [...reqs.values()].filter((r) => r.t1 == null && ["Fetch", "XHR", "Script", "Stylesheet", "Document"].includes(r.type)).length;
    const snap = await page.evaluate(() => ({ now: performance.now(), lastMutation: window.__perf?.lastMutation ?? 0, fcp: window.__perf?.fcp ?? null, text: document.body ? document.body.innerText.slice(0, 20000) : "" })).catch(() => null);
    if (!snap) continue;
    const textOk = spec.readyText ? spec.readyText.test(snap.text) : snap.fcp != null && snap.now > snap.fcp + 1000;
    const domQuiet = snap.now - snap.lastMutation > 500;
    if (textOk && inflight === 0 && domQuiet) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 600) {
        settledAt = Math.max(snap.lastMutation, ...[...reqs.values()].map((r) => 0));
        break;
      }
    } else {
      quietSince = null;
    }
  }
  const timedOut = settledAt == null;
  await page.waitForTimeout(5600);

  const perf = await page.evaluate(() => ({
    ...window.__perf,
    nodes: document.getElementsByTagName("*").length,
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    now: performance.now(),
  }));

  const all = [...reqs.values()];
  const doc = all.find((r) => r.type === "Document");
  const t0 = doc ? doc.t0 : all[0]?.t0 ?? 0;
  const settledMs = timedOut ? null : Math.max(perf.lastMutation, ...all.filter((r) => r.t1 != null && ["Fetch", "XHR"].includes(r.type)).map((r) => (r.t1 - t0) * 1000));
  const busy = busyNetworkIntervals(all, t0);
  const tti = computeTti(perf.fcp, perf.longTasks, busy);
  const tbt = perf.fcp == null || tti == null ? null : perf.longTasks.filter((t) => t.s >= perf.fcp && t.s < tti).reduce((s, t) => s + Math.max(0, t.d - 50), 0);

  const isApi = (r) => new URL(r.url).pathname.startsWith("/api/") && ["Fetch", "XHR"].includes(r.type);
  const settleCut = settledMs ?? Infinity;
  const beforeSettle = all.filter((r) => (r.t0 - t0) * 1000 <= settleCut);
  const sumBytes = (rs) => rs.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const by = (type) => beforeSettle.filter((r) => r.type === type);
  const api = beforeSettle.filter(isApi);

  const result = {
    page: spec.key,
    profile: profileName,
    run: runIndex,
    timedOut,
    ttfbMs: doc?.ttfb ?? null,
    fcpMs: perf.fcp,
    lcpMs: perf.lcp,
    lcpElement: perf.lcpInfo?.tag ?? null,
    cls: computeCls(perf.shifts),
    shifts: perf.shifts.filter((s) => s.v > 0.005),
    ttiMs: tti,
    tbtMs: tbt,
    settledMs,
    longTaskCount: perf.longTasks.length,
    longTaskTotalMs: perf.longTasks.reduce((s, t) => s + t.d, 0),
    domNodes: perf.nodes,
    heapMB: perf.heapMB,
    requests: beforeSettle.length,
    apiRequests: api.length,
    jsRequests: by("Script").length,
    jsBytes: sumBytes(by("Script")),
    cssBytes: sumBytes(by("Stylesheet")),
    apiBytes: sumBytes(api),
    totalBytes: sumBytes(beforeSettle),
    wsFrames: ws.frames,
    consoleErrors,
    apiCalls: api.map((r) => ({
      route: `${r.method} ${normalizeRoute(r.url)}`,
      status: r.status,
      startMs: (r.t0 - t0) * 1000,
      ttfbMs: r.ttfb,
      totalMs: r.t1 != null ? (r.t1 - r.t0) * 1000 : null,
      bytes: r.bytes ?? 0,
      serverTiming: r.serverTiming,
    })),
  };
  if (args.shots && runIndex === 0) {
    fs.mkdirSync(args.shots, { recursive: true });
    await page.screenshot({ path: path.join(args.shots, `${LABEL}-${spec.key}-${profileName}.png`) });
  }
  await context.close();
  return result;
}

function summarize(results) {
  const groups = new Map();
  for (const r of results) {
    const k = `${r.page}|${r.profile}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rows = [];
  for (const [k, rs] of groups) {
    const [page, profile] = k.split("|");
    const m = (f) => median(rs.map(f));
    const routeStats = new Map();
    for (const r of rs) {
      for (const c of r.apiCalls) {
        if (!routeStats.has(c.route)) routeStats.set(c.route, { ttfb: [], total: [], bytes: [], calls: 0, statuses: new Set() });
        const s = routeStats.get(c.route);
        s.ttfb.push(c.ttfbMs);
        s.total.push(c.totalMs);
        s.bytes.push(c.bytes);
        s.calls += 1;
        s.statuses.add(c.status);
      }
    }
    rows.push({
      page,
      profile,
      runs: rs.length,
      timedOut: rs.filter((r) => r.timedOut).length,
      fcpMs: m((r) => r.fcpMs),
      lcpMs: m((r) => r.lcpMs),
      cls: m((r) => r.cls),
      ttiMs: m((r) => r.ttiMs),
      tbtMs: m((r) => r.tbtMs),
      settledMs: m((r) => r.settledMs),
      requests: m((r) => r.requests),
      apiRequests: m((r) => r.apiRequests),
      jsKB: m((r) => r.jsBytes) / 1024,
      apiKB: m((r) => r.apiBytes) / 1024,
      totalKB: m((r) => r.totalBytes) / 1024,
      domNodes: m((r) => r.domNodes),
      heapMB: m((r) => r.heapMB),
      consoleErrors: rs.reduce((s, r) => s + r.consoleErrors.length, 0),
      api: [...routeStats.entries()]
        .map(([route, s]) => ({
          route,
          perLoad: s.calls / rs.length,
          ttfbP50: median(s.ttfb),
          ttfbP95: percentile(s.ttfb, 0.95),
          totalP50: median(s.total),
          totalP95: percentile(s.total, 0.95),
          kb: median(s.bytes) / 1024,
          statuses: [...s.statuses].join(","),
        }))
        .sort((a, b) => (b.totalP95 ?? 0) - (a.totalP95 ?? 0)),
    });
  }
  return rows;
}

const fmt = (v, d = 0) => (v == null ? "-" : v.toFixed(d));

function printTable(rows) {
  console.log("\n| page | profile | runs | FCP | LCP | CLS | TTI | TBT | settled | req | api | JS KB | total KB | nodes | heap MB | errors |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.page} | ${r.profile} | ${r.runs}${r.timedOut ? ` (${r.timedOut} timeout)` : ""} | ${fmt(r.fcpMs)} | ${fmt(r.lcpMs)} | ${fmt(r.cls, 3)} | ${fmt(r.ttiMs)} | ${fmt(r.tbtMs)} | ${fmt(r.settledMs)} | ${fmt(r.requests)} | ${fmt(r.apiRequests)} | ${fmt(r.jsKB)} | ${fmt(r.totalKB)} | ${fmt(r.domNodes)} | ${fmt(r.heapMB)} | ${r.consoleErrors} |`);
  }
}

async function main() {
  const pageKeys = args.pages ? String(args.pages).split(",") : PAGES.map((p) => p.key);
  const profileNames = String(args.profiles ?? "desktop,slow").split(",");
  const specs = PAGES.filter((p) => pageKeys.includes(p.key));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const load0 = os.loadavg()[0];
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const profileName of profileNames) {
      for (const spec of specs) {
        for (let i = 0; i < RUNS; i += 1) {
          const r = await measureRun(browser, spec, profileName, i);
          results.push(r);
          console.error(`[${profileName}] ${spec.key} #${i} lcp=${fmt(r.lcpMs)} tti=${fmt(r.ttiMs)} settled=${fmt(r.settledMs)} api=${r.apiRequests} errs=${r.consoleErrors.length}${r.timedOut ? " TIMEOUT" : ""}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  const rows = summarize(results);
  const meta = { label: LABEL, base: BASE, runs: RUNS, loadAvgStart: load0, loadAvgEnd: os.loadavg()[0], cpus: os.cpus().length, at: new Date().toISOString(), fixture: SEED.counts };
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify({ meta, rows, results }, null, 2));
  printTable(rows);
  console.log(`\nload avg ${meta.loadAvgStart.toFixed(1)} -> ${meta.loadAvgEnd.toFixed(1)} on ${meta.cpus} cpus; results: ${path.join(OUT_DIR, `${LABEL}.json`)}`);
}

await main();
