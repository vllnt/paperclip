/**
 * Render counts: how many React commits and component re-renders a page causes
 * while idle, under live mutations, and while typing in search.
 *
 *   node tests/perf/web-app/renders.mjs --page tasks-board --rate 12 --seconds 60 --label baseline
 *
 * Uses a stub React DevTools hook against the production build (no app changes):
 * every commit walks the fiber tree and counts fibers flagged PerformedWork.
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
const SECONDS = Number(opt("seconds", 60));
const RATE = Number(opt("rate", 12));
const LABEL = opt("label", `renders-${PAGE}`);
const OUT_DIR = opt("out", "tmp/perf/results");
const P = SEED.prefix;
const viewKey = `paperclip:issues-view:${SEED.companyId}`;

const PAGES = {
  "tasks-board": { url: `/${P}/issues`, storage: { [viewKey]: { viewMode: "board" } }, search: true },
  "tasks-list": { url: `/${P}/issues`, storage: { [viewKey]: { viewMode: "list" } }, search: true },
  dashboard: { url: `/${P}/dashboard` },
  "issue-long": { url: `/${P}/issues/${SEED.featured.long.identifier}` },
};
const spec = PAGES[PAGE];
if (!spec) throw new Error(`unknown page ${PAGE}`);

const HOOK = `(() => {
  const state = (window.__renders = { on: false, commits: 0, mounts: {}, updates: {}, fiberRenders: 0, commitMs: 0 });
  const nameOf = (fiber) => {
    const t = fiber.type;
    if (!t) return null;
    if (typeof t === "function") return t.displayName || t.name || "Anonymous";
    if (fiber.tag === 11) return (t.render && (t.render.displayName || t.render.name)) || t.displayName || "ForwardRef";
    if (fiber.tag === 14 || fiber.tag === 15) return (t.type && (t.type.displayName || t.type.name)) || t.displayName || "Memo";
    return null;
  };
  const renderTags = new Set([0, 1, 11, 14, 15]);
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    isDisabled: false,
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      if (!state.on) return;
      const started = performance.now();
      state.commits += 1;
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        if (renderTags.has(fiber.tag) && (fiber.flags & 1) === 1) {
          const name = nameOf(fiber);
          if (name) {
            const bucket = fiber.alternate === null ? state.mounts : state.updates;
            bucket[name] = (bucket[name] || 0) + 1;
            state.fiberRenders += 1;
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      state.commitMs += performance.now() - started;
    },
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
})();`;

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}`);
  return res.json().catch(() => null);
}

const list = await api("GET", `/api/companies/${SEED.companyId}/issues?limit=200`);
const ids = Array.isArray(list) ? list.map((i) => i.id) : [SEED.featured.long.id];
const priorities = ["low", "medium", "high", "critical"];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(HOOK);
if (spec.storage) {
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, JSON.stringify(v));
  }, spec.storage);
}
const page = await context.newPage();
await page.goto(BASE + spec.url, { waitUntil: "commit" });
await page.waitForFunction(() => /PER-\d+|Dashboard/.test(document.body.innerText), null, { timeout: 60_000 });
await page.waitForTimeout(6000);

const snapshot = () => page.evaluate(() => ({ commits: window.__renders.commits, fiberRenders: window.__renders.fiberRenders, commitMs: window.__renders.commitMs, updates: { ...window.__renders.updates }, mounts: { ...window.__renders.mounts } }));
const diff = (a, b) => {
  const keys = new Set([...Object.keys(b.updates), ...Object.keys(a.updates)]);
  const top = [...keys].map((k) => [k, (b.updates[k] ?? 0) - (a.updates[k] ?? 0)]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).slice(0, 12);
  return { commits: b.commits - a.commits, fiberRenders: b.fiberRenders - a.fiberRenders, commitMs: b.commitMs - a.commitMs, top };
};

await page.evaluate(() => { window.__renders.on = true; });
const out = { label: LABEL, page: PAGE, phases: {} };

const s0 = await snapshot();
await page.waitForTimeout(20_000);
const s1 = await snapshot();
out.phases.idle20s = diff(s0, s1);

let n = 0;
const gap = 60_000 / RATE;
const ticker = setInterval(() => {
  const id = ids[n % ids.length];
  const kind = n % 3;
  const op = kind === 2
    ? api("POST", `/api/issues/${id}/comments`, { body: `render probe ${n}` })
    : api("PATCH", `/api/issues/${id}`, { priority: priorities[n % priorities.length] });
  void op.catch(() => {});
  n += 1;
}, gap);
await page.waitForTimeout(SECONDS * 1000);
clearInterval(ticker);
await page.waitForTimeout(1500);
const s2 = await snapshot();
out.phases.live = { mutations: n, ...diff(s1, s2) };

if (spec.search) {
  const box = page.getByPlaceholder(/Search tasks/i);
  await box.click();
  const s3 = await snapshot();
  await page.keyboard.type("retry", { delay: 120 });
  await page.waitForTimeout(1200);
  const s4 = await snapshot();
  out.phases.type5chars = diff(s3, s4);
}

const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
out.domNodes = nodes;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `renders-${LABEL}.json`), JSON.stringify(out, null, 2));

for (const [phase, d] of Object.entries(out.phases)) {
  console.log(`${phase}: ${d.commits} commits, ${d.fiberRenders} component renders, ${d.commitMs.toFixed(0)} ms in hook walk${d.mutations ? `, ${d.mutations} mutations` : ""}`);
  console.log(`   top: ${d.top.map(([k, c]) => `${k}×${c}`).join(", ")}`);
}
console.log(`DOM nodes: ${nodes}`);
await browser.close();
