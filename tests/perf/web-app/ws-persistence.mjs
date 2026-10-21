/**
 * Websocket persistence: does the live-events socket survive client-side navigation, and do the
 * server's upgrade handlers still answer. Plan section 8, row "Websockets". Reports, never fails.
 *
 * Usage (server on :3192 seeded by make-fixture.mjs):
 *   node tests/perf/web-app/ws-persistence.mjs --label b1-r1
 *   node tests/perf/web-app/ws-persistence.mjs --label b1-r1 --dev     # also check the HMR socket
 *
 * Flags: --base --seed --label --out (lib/common.mjs), --navs 20 (client-side navigations), --dev.
 *
 * Rows (key → fields):
 *   live-socket        Browser: load the board, record `/api/companies/:id/events/ws`, click through
 *                      `--navs` sidebar links without a reload. opened, openedDuringNav, closedDuringNav,
 *                      aliveAtEnd, frames; status persistent | reconnected | no_socket. Plus `upgrade`,
 *                      the same path upgraded from Node.
 *   runner-upgrade     Node client, no ws dependency: a raw HTTP upgrade of /api/runner/v1/connect/<uuid>
 *                      (server/src/realtime/runner-prp-ws.ts). The handler answers an unknown run with
 *                      404 itself.
 *   terminal-upgrade   The same for /api/environment-custom-image-setup-sessions/<uuid>/terminal/ws
 *                      (environment-custom-image-terminal-ws.ts). The handler upgrades (101) and
 *                      authenticates in-band, so a bare upgrade with a terminalSessionId reaches it.
 *   hmr                With --dev: the Vite (today) or Next HMR socket seen by the browser. Vite in
 *                      middleware mode listens on a companion port (app port + 10000). not_applicable
 *                      when nothing listens there (static UI) or --dev is not set.
 *
 * `reachedHandler` = the answer came from the handler: a 101, or an HTTP status that the handler wrote
 * (401/403/404 ...), and it differs from the control, an upgrade of a path that no handler owns. A
 * socket that is destroyed without a response, or a control-identical answer, is `false`.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { parseArgs, readSeed, startMeta, writeResult } from "./lib/common.mjs";

const args = parseArgs();
const BASE = String(args.base ?? "http://127.0.0.1:3192").replace(/\/$/, "");
const OUT_DIR = args.out && args.out !== true ? args.out : "tmp/perf/results";
const NAVS = Number(args.navs ?? 20);
const DEV = Boolean(args.dev);
const SEED = readSeed(args.seed && args.seed !== true ? args.seed : undefined);
const LIVE_PATH = /\/api\/companies\/[^/]+\/events\/ws/;

/** The Vite HMR companion port: the app port + 10000, or - 10000 above 55535 (packages/shared runtime-exposure). */
function hmrPortFor(appPort) {
  return appPort + 10_000 <= 65_535 ? appPort + 10_000 : appPort - 10_000;
}

/** One raw upgrade request. outcome: upgraded | response | destroyed | refused | timeout. */
function rawUpgrade(pathAndQuery, { base = BASE, timeoutMs = 5000 } = {}) {
  const url = new URL(base);
  const client = url.protocol === "https:" ? https : http;
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve({ ...result, ms: Date.now() - started });
    };
    const req = client.request({
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: pathAndQuery,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        Origin: url.origin,
      },
      timeout: timeoutMs,
    });
    req.on("upgrade", (res, socket) => {
      finish({ outcome: "upgraded", status: res.statusCode });
      socket.destroy();
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.length < 4 && chunks.push(c));
      const reply = () =>
        finish({
          outcome: "response",
          status: res.statusCode,
          poweredBy: res.headers["x-powered-by"] ?? null,
          contentType: res.headers["content-type"] ?? null,
          body: Buffer.concat(chunks).toString("utf8").slice(0, 80),
        });
      res.on("end", reply);
      res.on("close", reply);
    });
    req.on("timeout", () => {
      finish({ outcome: "timeout" });
      req.destroy();
    });
    req.on("error", (error) => finish({ outcome: error.code === "ECONNREFUSED" ? "refused" : "destroyed", error: error.code ?? String(error.message).slice(0, 80) }));
    req.end();
  });
}

const answered = (r) => r.outcome === "upgraded" || r.outcome === "response";
const sameAnswer = (a, b) => answered(a) && answered(b) && a.outcome === b.outcome && a.status === b.status && (a.body ?? "") === (b.body ?? "");

async function upgradeRow(key, pathAndQuery, note) {
  const result = await rawUpgrade(pathAndQuery);
  const control = await rawUpgrade(`/api/perf-no-such-websocket/${crypto.randomUUID()}`);
  const reachedHandler = answered(result) && !sameAnswer(result, control);
  return {
    key,
    path: pathAndQuery.replace(/\?.*/, ""),
    note,
    outcome: result.outcome,
    status: reachedHandler ? "reached_handler" : result.outcome === "destroyed" ? "destroyed_no_response" : "not_reached",
    httpStatus: result.status ?? null,
    reachedHandler,
    responseBody: result.body ?? null,
    control: { outcome: control.outcome, httpStatus: control.status ?? null },
    ms: result.ms,
  };
}

async function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: new URL(BASE).hostname, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function collectLinks(page, prefix) {
  const hrefs = await page.$$eval("a[href]", (as) => as.filter((a) => a.getClientRects().length > 0).map((a) => a.getAttribute("href")));
  const seen = new Set();
  return hrefs.filter((h) => h && h.startsWith(`/${prefix}/`) && !/[#?]/.test(h) && !seen.has(h) && seen.add(h));
}

/** Clicks sidebar links `count` times without a reload; returns how many changed the URL. */
async function navigate(page, prefix, count) {
  const links = (await collectLinks(page, prefix)).slice(0, 8);
  let done = 0;
  for (let i = 0; i < count && links.length > 1; i += 1) {
    const before = new URL(page.url()).pathname;
    const href = links.find((h, j) => j >= i % links.length && h !== before) ?? links.find((h) => h !== before);
    const link = page.locator(`a[href="${href}"]:visible`).first();
    if (!(await link.count())) continue;
    await link.click({ timeout: 5000 }).catch(() => {});
    const moved = await page.waitForFunction((from) => location.pathname !== from, before, { timeout: 10_000 }).then(() => true, () => false);
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(150);
    if (moved) done += 1;
  }
  return { done, links: links.length };
}

async function browserProbe(hmrPort) {
  const browser = await chromium.launch({ headless: true });
  const sockets = [];
  let navStart = null;
  let navEnd = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript((id) => {
      try {
        localStorage.setItem("paperclip.selectedCompanyId", id);
      } catch {}
    }, SEED.companyId);
    const page = await context.newPage();
    page.on("websocket", (ws) => {
      const entry = { url: ws.url(), openedAt: Date.now(), closedAt: null, received: 0, sent: 0 };
      sockets.push(entry);
      ws.on("framereceived", () => (entry.received += 1));
      ws.on("framesent", () => (entry.sent += 1));
      ws.on("close", () => (entry.closedAt = Date.now()));
    });
    await page.goto(`${BASE}/${SEED.prefix}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const waitUntil = Date.now() + 10_000;
    while (!sockets.some((s) => LIVE_PATH.test(s.url)) && Date.now() < waitUntil) await page.waitForTimeout(200);
    navStart = Date.now();
    const nav = await navigate(page, SEED.prefix, NAVS);
    navEnd = Date.now();
    await page.waitForTimeout(500);
    return { sockets, navStart, navEnd, nav, hmrPort };
  } finally {
    await browser.close();
  }
}

function socketRow(key, matching, session, extra = {}) {
  const during = (t) => t !== null && t >= session.navStart && t <= session.navEnd;
  const opened = matching.length;
  const closedDuringNav = matching.filter((s) => during(s.closedAt)).length;
  const aliveAtEnd = opened > 0 && matching[matching.length - 1].closedAt === null;
  return {
    key,
    opened,
    openedDuringNav: matching.filter((s) => during(s.openedAt)).length,
    closedDuringNav,
    aliveAtEnd,
    frames: matching.reduce((n, s) => n + s.received + s.sent, 0),
    navigations: session.nav.done,
    navigationsRequested: NAVS,
    reachedHandler: opened > 0,
    status: opened === 0 ? "no_socket" : opened === 1 && closedDuringNav === 0 && aliveAtEnd ? "persistent" : "reconnected",
    ...extra,
  };
}

async function main() {
  const meta = startMeta("ws-persistence", args, { base: BASE, navs: NAVS, dev: DEV });
  const appPort = Number(new URL(BASE).port || (BASE.startsWith("https") ? 443 : 80));
  const hmrPort = hmrPortFor(appPort);
  const session = await browserProbe(hmrPort);
  const rows = [];

  const live = session.sockets.filter((s) => LIVE_PATH.test(s.url));
  const liveUpgrade = await rawUpgrade(`/api/companies/${SEED.companyId}/events/ws`);
  rows.push(socketRow("live-socket", live, session, { upgrade: { outcome: liveUpgrade.outcome, httpStatus: liveUpgrade.status ?? null }, navLinks: session.nav.links }));

  rows.push(await upgradeRow("runner-upgrade", `/api/runner/v1/connect/${crypto.randomUUID()}`, "unknown run id: the handler answers 404 itself"));
  rows.push(
    await upgradeRow(
      "terminal-upgrade",
      `/api/environment-custom-image-setup-sessions/${crypto.randomUUID()}/terminal/ws?terminalSessionId=${crypto.randomUUID()}&cols=80&rows=24`,
      "with a terminalSessionId the handler upgrades and authenticates in-band",
    ),
  );

  if (!DEV) {
    rows.push({ key: "hmr", opened: 0, closedDuringNav: 0, reachedHandler: false, status: "not_applicable", reason: "--dev not set" });
  } else {
    const hmr = session.sockets.filter((s) => {
      const u = new URL(s.url);
      return u.port === String(hmrPort) || u.pathname.includes("/_next/webpack-hmr");
    });
    if (hmr.length > 0) {
      rows.push(socketRow("hmr", hmr, session, { port: hmrPort }));
    } else if (!(await listening(hmrPort))) {
      rows.push({ key: "hmr", opened: 0, closedDuringNav: 0, reachedHandler: false, status: "not_applicable", reason: `no HMR socket and nothing listens on port ${hmrPort}: the UI is not served by a dev middleware` });
    } else {
      rows.push({ key: "hmr", opened: 0, closedDuringNav: 0, reachedHandler: false, status: "no_socket", reason: `port ${hmrPort} listens but the page opened no HMR socket`, port: hmrPort });
    }
  }

  meta.websockets = session.sockets.map((s) => ({ url: s.url.replace(/\?.*/, ""), received: s.received, sent: s.sent, closed: s.closedAt !== null }));
  const file = writeResult(meta, { rows }, OUT_DIR);
  for (const r of rows) {
    console.log(`${r.key.padEnd(17)} ${r.status.padEnd(20)} reachedHandler=${r.reachedHandler}${r.opened !== undefined ? ` opened=${r.opened} closedDuringNav=${r.closedDuringNav}` : ""}${r.httpStatus !== undefined ? ` http=${r.httpStatus ?? r.outcome} control=${r.control.httpStatus ?? r.control.outcome}` : ""}${r.frames !== undefined ? ` frames=${r.frames} navs=${r.navigations}/${r.navigationsRequested}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
  }
  console.log(`results: ${file}`);
}

await main();
