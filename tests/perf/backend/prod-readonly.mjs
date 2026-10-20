#!/usr/bin/env node
// Read-only latency prober for a running Paperclip instance.
//
// Sends only GET requests, one at a time, interleaved across routes, with a
// board API key. Use it to take the "before" numbers of a change and to
// re-measure the touched routes after the change is deployed.
//
//   PAPERCLIP_API_URL=https://host PAPERCLIP_API_KEY=... \
//     node tests/perf/backend/prod-readonly.mjs run --company-id <id> --issue <identifier> \
//       --label before --out before.json
//
//   node tests/perf/backend/prod-readonly.mjs compare before.json after.json
//
// The key is read from the environment and never printed or written.
// `serverMs` is the time from the end of the TLS handshake to the first
// response byte. It still contains one network round trip; the report gives
// `workMs`, which subtracts the median of the health route (the floor).
// Host load and memory come from GET /api/instance/resource-capacity and are
// sampled while the run goes on; the API has no per-process CPU or memory.
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const FLOOR_ROUTE = "health";

/** Routes. {c} = company id, {i} = issue id or identifier. */
const ROUTES = [
  { name: "health", path: "/api/health" },
  { name: "instance-settings", path: "/api/instance/settings/experimental" },
  { name: "auth-session", path: "/api/auth/get-session" },
  { name: "cli-auth-me", path: "/api/cli-auth/me" },
  { name: "adapters", path: "/api/adapters" },
  { name: "plugin-ui", path: "/api/plugins/ui-contributions" },
  { name: "dashboard", path: "/api/companies/{c}/dashboard" },
  { name: "sidebar-badges", path: "/api/companies/{c}/sidebar-badges" },
  { name: "live-runs", path: "/api/companies/{c}/live-runs" },
  { name: "activity", path: "/api/companies/{c}/activity" },
  // Without `limit` the route returns every run of the company (tens of MB), so the probe always bounds it.
  { name: "heartbeat-runs", path: "/api/companies/{c}/heartbeat-runs?limit=200" },
  { name: "agents", path: "/api/companies/{c}/agents" },
  { name: "skills", path: "/api/companies/{c}/skills" },
  { name: "attention", path: "/api/companies/{c}/attention" },
  { name: "issues-default", path: "/api/companies/{c}/issues" },
  { name: "issues-compact", path: "/api/companies/{c}/issues?view=compact&limit=100" },
  { name: "issue-by-id", path: "/api/issues/{i}", needs: "issue" },
  { name: "resource-capacity", path: "/api/instance/resource-capacity" },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const round = (x) => Math.round(x * 10) / 10;
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
}

function request(base, path, { key, acceptEncoding, ifNoneMatch, timeoutMs = 60_000 }) {
  const url = new URL(path, base);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const t0 = performance.now();
    let tConnect = null;
    let tSecure = null;
    let tFirst = null;
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Accept-Encoding": acceptEncoding };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    // A new connection per request, like a first browser request: no keep-alive reuse.
    const req = transport.request(url, { method: "GET", headers, agent: false, timeout: timeoutMs }, (res) => {
      tFirst = performance.now();
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const tEnd = performance.now();
        const body = Buffer.concat(chunks);
        const base0 = tSecure ?? tConnect ?? t0;
        resolve({
          ok: true,
          status: res.statusCode ?? 0,
          headers: res.headers,
          wireBytes: body.length,
          body,
          serverMs: tFirst - base0,
          totalMs: tEnd - t0,
        });
      });
      res.on("error", (error) => resolve({ ok: false, error: String(error?.code ?? error) }));
    });
    req.on("socket", (socket) => {
      socket.once("connect", () => { tConnect = performance.now(); });
      socket.once("secureConnect", () => { tSecure = performance.now(); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ ok: false, error: String(error?.code ?? error?.message ?? error) }));
    req.end();
  });
}

function decodedLength(result) {
  const encoding = String(result.headers["content-encoding"] ?? "identity").toLowerCase();
  if (encoding === "identity") return result.body.length;
  if (encoding === "gzip") {
    try { return gunzipSync(result.body).length; } catch { return null; }
  }
  return null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function hostSample(base, key) {
  const result = await request(base, "/api/instance/resource-capacity", { key, acceptEncoding: "identity" });
  if (!result.ok || result.status !== 200) return null;
  try {
    const data = JSON.parse(result.body.toString("utf8"));
    const host = (data.hosts ?? []).find((h) => h.current) ?? null;
    if (!host) return null;
    return {
      at: new Date().toISOString(),
      sampledAt: host.sampledAt,
      cpuCount: host.cpuCount,
      load1: host.load1,
      load5: host.load5,
      loadPerCore: host.loadPerCore,
      memTotalBytes: host.memTotalBytes,
      memAvailableBytes: host.memAvailableBytes,
    };
  } catch {
    return null;
  }
}

async function run(values) {
  const base = process.env.PAPERCLIP_API_URL;
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set");
  const companyId = values["company-id"];
  if (!companyId) throw new Error("--company-id is required");
  const n = Number(values.n ?? 30);
  const gapMs = Number(values["gap-ms"] ?? 250);
  const only = values.only ? new Set(String(values.only).split(",")) : null;
  const issue = values.issue ?? null;

  const routes = ROUTES.filter((r) => (!only || only.has(r.name) || r.name === FLOOR_ROUTE) && (r.needs !== "issue" || issue));
  const resolved = routes.map((r) => ({ ...r, url: r.path.replace("{c}", encodeURIComponent(companyId)).replace("{i}", encodeURIComponent(issue ?? "")) }));

  const health = await request(base, "/api/health", { key, acceptEncoding: "identity" });
  let commit = null;
  try { commit = JSON.parse(health.body.toString("utf8")).commit ?? null; } catch { /* keep null */ }

  // The client's own load inflates TTFB when it is busy, so it is recorded next to the host's.
  const startedAt = new Date().toISOString();
  const clientLoad = [loadavg()[0]];
  const hostSamples = [];
  const sampleHost = async () => { const s = await hostSample(base, key); if (s) hostSamples.push(s); };
  await sampleHost();
  const hostTimer = setInterval(() => { void sampleHost(); }, 30_000);

  const state = Object.fromEntries(resolved.map((r) => [r.name, { path: r.url, server: [], total: [], statuses: {}, errors: 0, wireBytes: null, identityBytes: null, contentEncoding: null, etag: false, serverTiming: null }]));

  // One request per route per round, so slow drift of the host hits all routes alike.
  for (let round = 0; round < n; round += 1) {
    for (const route of resolved) {
      const result = await request(base, route.url, { key, acceptEncoding: "gzip" });
      const s = state[route.name];
      if (!result.ok) { s.errors += 1; await sleep(gapMs); continue; }
      s.statuses[result.status] = (s.statuses[result.status] ?? 0) + 1;
      if (result.status === 200) {
        s.server.push(result.serverMs);
        s.total.push(result.totalMs);
        s.wireBytes = result.wireBytes;
        s.contentEncoding = result.headers["content-encoding"] ?? null;
        s.etag = Boolean(result.headers.etag);
        s.vary = result.headers.vary ?? null;
        s.cacheControl = result.headers["cache-control"] ?? null;
        s.serverTiming = result.headers["server-timing"] ?? s.serverTiming;
        if (round === 0) {
          const plain = await request(base, route.url, { key, acceptEncoding: "identity" });
          s.identityBytes = plain.ok ? plain.body.length : decodedLength(result);
          // One conditional request per route: does the server answer 304 for the ETag it sent?
          if (result.headers.etag) {
            const cond = await request(base, route.url, { key, acceptEncoding: "gzip", ifNoneMatch: String(result.headers.etag) });
            s.conditionalStatus = cond.ok ? cond.status : null;
          }
        }
      }
      await sleep(gapMs);
    }
  }
  clearInterval(hostTimer);
  await sampleHost();
  clientLoad.push(loadavg()[0]);

  const floor = state[FLOOR_ROUTE]?.server ?? [];
  const floorP50 = floor.length ? percentile([...floor].sort((a, b) => a - b), 50) : 0;
  const routesOut = {};
  for (const [name, s] of Object.entries(state)) {
    routesOut[name] = {
      path: s.path,
      statuses: s.statuses,
      errors: s.errors,
      wireBytes: s.wireBytes,
      identityBytes: s.identityBytes,
      contentEncoding: s.contentEncoding,
      etag: s.etag,
      vary: s.vary ?? null,
      cacheControl: s.cacheControl ?? null,
      conditionalStatus: s.conditionalStatus ?? null,
      serverTiming: s.serverTiming,
      serverMs: summarize(s.server),
      totalMs: summarize(s.total),
      workMs: summarize(s.server.map((v) => Math.max(0, v - floorP50))),
      samples: { serverMs: s.server.map((v) => Math.round(v * 10) / 10), totalMs: s.total.map((v) => Math.round(v * 10) / 10) },
    };
  }
  const report = {
    label: values.label ?? "run",
    startedAt,
    endedAt: new Date().toISOString(),
    node: process.version,
    commit,
    n,
    gapMs,
    floorP50Ms: Math.round(floorP50 * 10) / 10,
    clientLoad1: clientLoad.map((v) => Math.round(v * 100) / 100),
    host: hostSamples,
    routes: routesOut,
  };
  if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`);
  printTable(report);
}

function fmt(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function printTable(report) {
  console.log(`label=${report.label} commit=${fmt(report.commit)?.slice(0, 9)} n=${report.n} floor(health p50)=${report.floorP50Ms}ms`);
  if (report.clientLoad1) console.log(`client load1 start/end: ${report.clientLoad1.join(" / ")}`);
  const hostRows = report.host;
  if (hostRows.length) {
    const loads = hostRows.map((h) => h.load1);
    const mem = hostRows.map((h) => h.memAvailableBytes / 1048576);
    console.log(`host: cpus=${hostRows[0].cpuCount} load1 ${Math.min(...loads)}..${Math.max(...loads)} memAvailable ${Math.round(Math.min(...mem))}..${Math.round(Math.max(...mem))} MiB of ${Math.round(hostRows[0].memTotalBytes / 1048576)}`);
  }
  console.log("route".padEnd(20), "status".padEnd(10), "work p50".padStart(9), "p95".padStart(8), "p99".padStart(8), "total p50".padStart(10), "p95".padStart(8), "wire B".padStart(9), "plain B".padStart(9), "enc".padEnd(6), "etag 304");
  for (const [name, r] of Object.entries(report.routes)) {
    const status = Object.entries(r.statuses).map(([k, v]) => `${k}x${v}`).join(",") || `err${r.errors}`;
    console.log(
      name.padEnd(20), status.padEnd(10),
      fmt(r.workMs?.p50).padStart(9), fmt(r.workMs?.p95).padStart(8), fmt(r.workMs?.p99).padStart(8),
      fmt(r.totalMs?.p50).padStart(10), fmt(r.totalMs?.p95).padStart(8),
      fmt(r.wireBytes).padStart(9), fmt(r.identityBytes).padStart(9), fmt(r.contentEncoding).padEnd(6),
      r.etag ? `yes ${fmt(r.conditionalStatus)}` : "no",
    );
  }
}

// Deterministic RNG so a comparison gives the same interval each time.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 95% bootstrap interval of (after - before) / before, in percent, for a statistic. */
function bootstrapDelta(before, after, stat, iterations = 2000) {
  const rng = mulberry32(20261020);
  const draw = (arr) => Array.from({ length: arr.length }, () => arr[Math.floor(rng() * arr.length)]);
  const base = stat(before);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) deltas.push(((stat(draw(after)) - stat(draw(before))) / base) * 100);
  deltas.sort((a, b) => a - b);
  return { delta: ((stat(after) - base) / base) * 100, lo: deltas[Math.floor(iterations * 0.025)], hi: deltas[Math.floor(iterations * 0.975)] };
}

function verdict(interval, threshold) {
  if (interval.hi <= threshold) return "pass";
  if (interval.lo > threshold) return "FAIL";
  return "inconclusive";
}

function compare(beforePath, afterPath, values) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const t50 = Number(values["threshold-p50"] ?? 3);
  const t95 = Number(values["threshold-p95"] ?? 5);
  const only = values.only ? new Set(String(values.only).split(",")) : null;
  console.log(`before=${before.label}@${fmt(before.commit)?.slice(0, 9)} after=${after.label}@${fmt(after.commit)?.slice(0, 9)} thresholds: p50 +${t50}%, p95 +${t95}% (positive = slower)`);
  console.log("route".padEnd(20), "metric".padEnd(9), "before".padStart(9), "after".padStart(9), "delta%".padStart(8), "95% interval".padStart(18), "verdict");
  for (const name of Object.keys(after.routes)) {
    if (only && !only.has(name)) continue;
    const b = before.routes[name];
    const a = after.routes[name];
    if (!b || !a) continue;
    const bs = b.samples.serverMs;
    const as = a.samples.serverMs;
    if (bs.length < 5 || as.length < 5) { console.log(name.padEnd(20), "too few samples"); continue; }
    const p95 = (arr) => percentile([...arr].sort((x, y) => x - y), 95);
    for (const [metric, stat, threshold] of [["serverMs p50", median, t50], ["serverMs p95", p95, t95]]) {
      const interval = bootstrapDelta(bs, as, stat);
      console.log(
        name.padEnd(20), metric.slice(9).padEnd(9),
        String(Math.round(stat(bs) * 10) / 10).padStart(9), String(Math.round(stat(as) * 10) / 10).padStart(9),
        interval.delta.toFixed(1).padStart(8), `[${interval.lo.toFixed(1)}, ${interval.hi.toFixed(1)}]`.padStart(18), verdict(interval, threshold),
      );
    }
    if (b.wireBytes !== a.wireBytes) console.log(" ".repeat(20), "wire bytes".padEnd(9), String(b.wireBytes).padStart(9), String(a.wireBytes).padStart(9));
  }
}

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    "company-id": { type: "string" },
    issue: { type: "string" },
    n: { type: "string" },
    "gap-ms": { type: "string" },
    only: { type: "string" },
    label: { type: "string" },
    out: { type: "string" },
    "threshold-p50": { type: "string" },
    "threshold-p95": { type: "string" },
  },
});

if (command === "run") {
  await run(parsed.values);
} else if (command === "compare" && parsed.positionals.length === 2) {
  compare(parsed.positionals[0], parsed.positionals[1], parsed.values);
} else {
  console.error("usage: prod-readonly.mjs run --company-id <id> [--issue <id>] [--n 30] [--only a,b] [--label x] [--out file]\n       prod-readonly.mjs compare before.json after.json [--only a,b]");
  process.exit(2);
}
