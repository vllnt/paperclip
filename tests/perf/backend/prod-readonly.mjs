#!/usr/bin/env node
// Latency prober for a running Paperclip instance.
//
// Sends only GET requests, one at a time, with a board API key. Some GET
// handlers do housekeeping writes (the key's last-used time, recovery
// clean-up, the skills import), the same as a page view in the UI. Use it to
// take the "before" numbers of a change and to re-measure the touched routes
// after the change is deployed.
//
//   PAPERCLIP_API_URL=https://host PAPERCLIP_API_KEY=... \
//     node tests/perf/backend/prod-readonly.mjs run --company-id <id> --issue <identifier> \
//       --label before --out before.json
//
//   node tests/perf/backend/prod-readonly.mjs compare before.json after.json --aa a1.json,a2.json
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
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const FLOOR_ROUTE = "health";
const SEED = 20261020;

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

/** Nearest rank: with 30 values, p50 is the 15th, p95 the 29th and p99 the 30th. */
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

// Deterministic RNG, so the route order of a run and the interval of a comparison repeat.
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

function shuffled(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function integerOption(value, fallback, name, min) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer of at least ${min}`);
  return parsed;
}

/** True for a host that only this machine can reach. */
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Refuse a target that would send the key in clear text or hammer a remote host. */
function checkTarget(base, gapMs) {
  let url;
  try { url = new URL(base); } catch { throw new Error("PAPERCLIP_API_URL is not a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("PAPERCLIP_API_URL must start with http: or https:");
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new Error("PAPERCLIP_API_URL uses http: and the key would go in clear text; use https: unless the host is loopback");
  if (gapMs === 0 && !loopback) throw new Error("--gap-ms 0 sends requests back to back; use it only on a loopback host");
}

// `idleTimeoutMs` is an idle timeout (no data on the socket for that long), not a limit on the whole request.
function request(base, path, { key, acceptEncoding, ifNoneMatch, idleTimeoutMs = 60_000 }) {
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
    const req = transport.request(url, { method: "GET", headers, agent: false, timeout: idleTimeoutMs }, (res) => {
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
  const decoders = { identity: (b) => b, gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync };
  const decode = decoders[encoding];
  if (!decode) return null;
  try { return decode(result.body).length; } catch { return null; }
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
  const n = integerOption(values.n, 30, "--n", 1);
  const gapMs = integerOption(values["gap-ms"], 250, "--gap-ms", 0);
  checkTarget(base, gapMs);
  const acceptEncoding = values["accept-encoding"] ?? "gzip";
  const only = values.only ? new Set(String(values.only).split(",")) : null;
  const issue = values.issue ?? null;

  const routes = ROUTES.filter((r) => (!only || only.has(r.name) || r.name === FLOOR_ROUTE) && (r.needs !== "issue" || issue));
  const resolved = routes.map((r) => ({ ...r, url: r.path.replace("{c}", encodeURIComponent(companyId)).replace("{i}", encodeURIComponent(issue ?? "")) }));

  const health = await request(base, "/api/health", { key, acceptEncoding: "identity" });
  if (!health.ok || health.status !== 200) throw new Error(`GET /api/health answered ${health.ok ? health.status : health.error}, not 200`);
  let commit = null;
  try { commit = JSON.parse(health.body.toString("utf8")).commit ?? null; } catch { /* keep null */ }

  // The client's own load inflates TTFB when it is busy, so it is recorded next to the host's.
  const startedAt = new Date().toISOString();
  const clientLoad = [loadavg()[0]];
  const hostSamples = [];
  const sampleHost = async () => { const s = await hostSample(base, key); if (s) hostSamples.push(s); };
  await sampleHost();
  const hostTimer = setInterval(() => { void sampleHost(); }, 30_000);

  // `path` keeps the route template, so a report holds no company id or issue identifier.
  const state = Object.fromEntries(resolved.map((r) => [r.name, { path: r.path, server: [], total: [], statuses: {}, errors: 0, probed: false, wireBytes: null, identityBytes: null, contentEncoding: null, etag: false, serverTiming: null }]));

  // One request per route per round, so slow drift of the host hits all routes
  // alike. The order is shuffled each round, so no route always follows the same one.
  const rng = mulberry32(SEED);
  for (let round = 0; round < n; round += 1) {
    for (const route of shuffled(resolved, rng)) {
      const result = await request(base, route.url, { key, acceptEncoding });
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
        if (!s.probed) {
          s.probed = true;
          const plain = await request(base, route.url, { key, acceptEncoding: "identity" });
          s.identityBytes = plain.ok && plain.status === 200 ? plain.body.length : decodedLength(result);
          // One conditional request per route: does the server answer 304 for the ETag it sent?
          if (result.headers.etag) {
            const cond = await request(base, route.url, { key, acceptEncoding, ifNoneMatch: String(result.headers.etag) });
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
  const floorP50 = floor.length ? percentile([...floor].sort((a, b) => a - b), 50) : null;
  if (floorP50 === null) {
    console.error("warning: the health route never answered 200, so there is no floor and no workMs");
    process.exitCode = 1;
  }
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
      workMs: floorP50 === null ? null : summarize(s.server.map((v) => Math.max(0, v - floorP50))),
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
    acceptEncoding,
    floorP50Ms: floorP50 === null ? null : Math.round(floorP50 * 10) / 10,
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
  console.log(`label=${report.label} commit=${fmt(report.commit)?.slice(0, 9)} n=${report.n} accept-encoding=${fmt(report.acceptEncoding)} floor(health p50)=${fmt(report.floorP50Ms)}ms`);
  if (report.clientLoad1) console.log(`client load1 start/end: ${report.clientLoad1.join(" / ")}`);
  const hostRows = report.host;
  if (hostRows.length) {
    const loads = hostRows.map((h) => h.load1);
    const mem = hostRows.map((h) => h.memAvailableBytes / 1048576);
    console.log(`host: cpus=${hostRows[0].cpuCount} load1 ${Math.min(...loads)}..${Math.max(...loads)} memAvailable ${Math.round(Math.min(...mem))}..${Math.round(Math.max(...mem))} MiB of ${Math.round(hostRows[0].memTotalBytes / 1048576)}`);
  }
  console.log("route".padEnd(20), "status".padEnd(10), "work p50".padStart(9), "p95".padStart(8), "p99".padStart(8), "total p50".padStart(10), "p95".padStart(8), "wire B".padStart(9), "plain B".padStart(9), "enc".padEnd(6), "etag 304");
  for (const [name, r] of Object.entries(report.routes)) {
    const status = [...Object.entries(r.statuses).map(([k, v]) => `${k}x${v}`), ...(r.errors ? [`errx${r.errors}`] : [])].join(",");
    console.log(
      name.padEnd(20), status.padEnd(10),
      fmt(r.workMs?.p50).padStart(9), fmt(r.workMs?.p95).padStart(8), fmt(r.workMs?.p99).padStart(8),
      fmt(r.totalMs?.p50).padStart(10), fmt(r.totalMs?.p95).padStart(8),
      fmt(r.wireBytes).padStart(9), fmt(r.identityBytes).padStart(9), fmt(r.contentEncoding).padEnd(6),
      r.etag ? `yes ${fmt(r.conditionalStatus)}` : "no",
    );
  }
}

const p50 = (values) => percentile([...values].sort((a, b) => a - b), 50);
const p95 = (values) => percentile([...values].sort((a, b) => a - b), 95);

/** Change of a statistic, (after - before) / before, in percent. Positive = slower. */
function change(before, after, stat) {
  return ((stat(after) - stat(before)) / stat(before)) * 100;
}

/** 95% bootstrap interval of the change. It treats the samples of one run as independent. */
function bootstrapChange(before, after, stat, iterations = 2000) {
  const rng = mulberry32(SEED);
  const draw = (arr) => Array.from({ length: arr.length }, () => arr[Math.floor(rng() * arr.length)]);
  const base = stat(before);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) deltas.push(((stat(draw(after)) - stat(draw(before))) / base) * 100);
  deltas.sort((a, b) => a - b);
  return { delta: change(before, after, stat), lo: deltas[Math.floor(iterations * 0.025)], hi: deltas[Math.floor(iterations * 0.975)] };
}

/**
 * The A/A noise of a route: the larger of the two changes between two runs of
 * the same commit, taken in both directions. Runs on a shared host drift, so a
 * change inside this band says nothing.
 */
function aaNoise(aa, name, stat) {
  if (!aa) return 0;
  const first = aa[0].routes[name]?.samples.serverMs ?? [];
  const second = aa[1].routes[name]?.samples.serverMs ?? [];
  if (first.length < 5 || second.length < 5) return null;
  return Math.max(Math.abs(change(first, second, stat)), Math.abs(change(second, first, stat)));
}

function failureShare(route) {
  const total = Object.values(route.statuses).reduce((sum, count) => sum + count, 0) + route.errors;
  const failed = total - (route.statuses[200] ?? 0);
  return { failed, total };
}

function label(interval, noise) {
  if (noise === null) return "no A/A data";
  if (interval.lo > noise) return "slower";
  if (interval.hi < -noise) return "faster";
  return noise > 0 ? "within A/A noise" : "no clear change";
}

function compare(beforePath, afterPath, values, aaPaths) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const aa = aaPaths ? aaPaths.map((path) => JSON.parse(readFileSync(path, "utf8"))) : null;
  const only = values.only ? new Set(String(values.only).split(",")) : null;
  console.log(`before=${before.label}@${fmt(before.commit)?.slice(0, 9)} after=${after.label}@${fmt(after.commit)?.slice(0, 9)} (positive = slower)`);
  console.log("The interval treats the samples of one run as independent. Two runs of the same commit drift on a shared host,");
  console.log(aa
    ? `so a change counts only beyond the A/A noise of ${aa[0].label} and ${aa[1].label}. This is not the paired rule of plan section 8.`
    : "so read the label as a trend only; pass --aa first.json,second.json to set the noise. This is not the paired rule of plan section 8.");
  console.log("route".padEnd(20), "metric".padEnd(7), "before".padStart(9), "after".padStart(9), "change%".padStart(8), "95% interval".padStart(18), "A/A noise".padStart(10), "label");
  for (const name of Object.keys(after.routes)) {
    if (only && !only.has(name)) continue;
    const b = before.routes[name];
    const a = after.routes[name];
    if (!b || !a) continue;
    const bf = failureShare(b);
    const af = failureShare(a);
    const moreFailures = af.total > 0 && bf.total > 0 && af.failed / af.total > bf.failed / bf.total;
    if (moreFailures || af.failed > 0) {
      console.log(name.padEnd(20), "non-200".padEnd(7), `${bf.failed}/${bf.total}`.padStart(9), `${af.failed}/${af.total}`.padStart(9), " ".repeat(38), moreFailures ? "MORE FAILURES" : "same or fewer failures");
    }
    const bs = b.samples.serverMs;
    const as = a.samples.serverMs;
    if (bs.length < 5 || as.length < 5) { console.log(name.padEnd(20), "too few 200 samples"); continue; }
    for (const [metric, stat] of [["p50", p50], ["p95", p95]]) {
      const interval = bootstrapChange(bs, as, stat);
      const noise = aaNoise(aa, name, stat);
      console.log(
        name.padEnd(20), metric.padEnd(7),
        String(stat(bs)).padStart(9), String(stat(as)).padStart(9),
        interval.delta.toFixed(1).padStart(8), `[${interval.lo.toFixed(1)}, ${interval.hi.toFixed(1)}]`.padStart(18),
        (noise === null ? "-" : noise.toFixed(1)).padStart(10), label(interval, noise),
      );
    }
    if (b.wireBytes !== a.wireBytes) console.log(" ".repeat(20), "wire B".padEnd(7), String(b.wireBytes).padStart(9), String(a.wireBytes).padStart(9));
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
    "accept-encoding": { type: "string" },
    only: { type: "string" },
    label: { type: "string" },
    out: { type: "string" },
    aa: { type: "string" },
  },
});

const usage = "usage: prod-readonly.mjs run --company-id <id> [--issue <id>] [--n 30] [--gap-ms 250] [--accept-encoding gzip] [--only a,b] [--label x] [--out file]\n       prod-readonly.mjs compare before.json after.json [--aa first.json,second.json] [--only a,b]";
const aaPaths = parsed.values.aa ? parsed.values.aa.split(",") : null;
if (command === "run") {
  await run(parsed.values);
} else if (command === "compare" && parsed.positionals.length === 2 && (!aaPaths || aaPaths.length === 2)) {
  compare(parsed.positionals[0], parsed.positionals[1], parsed.values, aaPaths);
} else {
  console.error(usage);
  process.exit(2);
}
