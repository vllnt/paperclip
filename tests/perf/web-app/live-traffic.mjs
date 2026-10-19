/**
 * Live-update traffic: what an open tab costs while nothing happens (idle) and
 * while other users/agents mutate data (busy).
 *
 *   node tests/perf/web-app/live-traffic.mjs --page tasks-board --seconds 120
 *   node tests/perf/web-app/live-traffic.mjs --page tasks-board --seconds 90 --rate 12   # 12 mutations/min
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
const PAGE = opt("page", "tasks-board");
const SECONDS = Number(opt("seconds", 120));
const RATE = Number(opt("rate", 0));
const LABEL = opt("label", `${PAGE}-${RATE ? `busy${RATE}` : "idle"}`);
const OUT_DIR = opt("out", "tmp/perf/results");
const P = SEED.prefix;
const viewKey = `paperclip:issues-view:${SEED.companyId}`;

const PAGES = {
  "tasks-board": { url: `/${P}/issues`, storage: { [viewKey]: { viewMode: "board" } } },
  "tasks-list": { url: `/${P}/issues`, storage: { [viewKey]: { viewMode: "list" } } },
  dashboard: { url: `/${P}/dashboard` },
  "issue-long": { url: `/${P}/issues/${SEED.featured.long.identifier}` },
  agents: { url: `/${P}/agents/all` },
};
const spec = PAGES[PAGE];
if (!spec) throw new Error(`unknown page ${PAGE}`);

function normalizeRoute(rawUrl) {
  const u = new URL(rawUrl);
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  const p = u.pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")
    .replace(/\/[A-Z]{2,6}-\d+(?=\/|$)/g, "/:identifier");
  return keys.length ? `${p}?${keys.join("&")}` : p;
}

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}`);
  return res.json().catch(() => null);
}

const issues = (await api("GET", `/api/companies/${SEED.companyId}/issues?limit=200`)).map?.((i) => i.id) ?? [];
const pool = issues.length ? issues : [SEED.featured.long.id];
const priorities = ["low", "medium", "high", "critical"];
let mutationCount = 0;

async function mutate(n) {
  const id = pool[n % pool.length];
  const kind = n % 4;
  if (kind === 0 || kind === 1) await api("PATCH", `/api/issues/${id}`, { priority: priorities[(n >> 2) % priorities.length] });
  else if (kind === 2) await api("POST", `/api/issues/${id}/comments`, { body: `live-traffic probe ${n}` });
  else await api("POST", `/api/companies/${SEED.companyId}/issues`, { title: `Live probe ${Date.now()}`, status: "todo", priority: "low", allowDuplicate: true });
  mutationCount += 1;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (spec.storage) {
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, JSON.stringify(v));
  }, spec.storage);
}
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");

let recording = false;
const http = new Map();
const wsTypes = new Map();
let wsFrames = 0;
let wsBytes = 0;
let httpBytes = 0;
const inflight = new Map();
cdp.on("Network.requestWillBeSent", (e) => {
  if (!["Fetch", "XHR"].includes(e.type)) return;
  if (recording) {
    const key = `${e.request.method} ${normalizeRoute(e.request.url)}`;
    http.set(key, (http.get(key) ?? 0) + 1);
  }
  inflight.set(e.requestId, recording);
});
cdp.on("Network.loadingFinished", (e) => {
  if (inflight.get(e.requestId)) httpBytes += e.encodedDataLength;
  inflight.delete(e.requestId);
});
cdp.on("Network.webSocketFrameReceived", (e) => {
  if (!recording) return;
  const data = e.response?.payloadData ?? "";
  wsFrames += 1;
  wsBytes += data.length;
  let type = "unparsed";
  try {
    type = JSON.parse(data).type ?? "untyped";
  } catch {}
  wsTypes.set(type, (wsTypes.get(type) ?? 0) + 1);
});

await page.goto(BASE + spec.url, { waitUntil: "commit" });
await page.waitForFunction(() => /PER-\d+|Dashboard|Agent \d\d/.test(document.body.innerText), null, { timeout: 60_000 });
await page.waitForTimeout(8000);

recording = true;
const t0 = Date.now();
let ticker = null;
if (RATE > 0) {
  const gap = 60_000 / RATE;
  let n = 0;
  ticker = setInterval(() => void mutate(n++).catch((e) => console.error("mutation failed", String(e))), gap);
}
await new Promise((r) => setTimeout(r, SECONDS * 1000));
recording = false;
if (ticker) clearInterval(ticker);
const elapsedMin = (Date.now() - t0) / 60_000;
await page.waitForTimeout(1500);

const heap = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null));
const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
const totalHttp = [...http.values()].reduce((s, n) => s + n, 0);
const result = {
  label: LABEL,
  page: PAGE,
  seconds: SECONDS,
  mutationsPerMin: RATE,
  mutations: mutationCount,
  httpTotal: totalHttp,
  httpPerMin: totalHttp / elapsedMin,
  httpKBPerMin: httpBytes / 1024 / elapsedMin,
  wsFramesPerMin: wsFrames / elapsedMin,
  wsKBPerMin: wsBytes / 1024 / elapsedMin,
  httpPerMutation: mutationCount ? totalHttp / mutationCount : null,
  heapMB: heap,
  domNodes: nodes,
  byRoute: [...http.entries()].sort((a, b) => b[1] - a[1]).map(([route, n]) => ({ route, count: n, perMin: n / elapsedMin })),
  wsByType: [...wsTypes.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, count: n, perMin: n / elapsedMin })),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `live-${LABEL}.json`), JSON.stringify(result, null, 2));

console.log(`${LABEL}: ${SECONDS}s window, ${mutationCount} mutations`);
console.log(`  HTTP ${result.httpTotal} requests = ${result.httpPerMin.toFixed(1)}/min, ${result.httpKBPerMin.toFixed(0)} KB/min${result.httpPerMutation ? `, ${result.httpPerMutation.toFixed(1)} per mutation` : ""}`);
console.log(`  WS ${result.wsFramesPerMin.toFixed(1)} frames/min, ${result.wsKBPerMin.toFixed(1)} KB/min; heap ${heap?.toFixed(0)} MB, ${nodes} nodes`);
for (const r of result.byRoute.slice(0, 12)) console.log(`  ${String(r.count).padStart(4)}  ${r.route}`);
for (const w of result.wsByType.slice(0, 8)) console.log(`  ws ${String(w.count).padStart(4)}  ${w.type}`);
await browser.close();
