/**
 * Server load of the board (plan section 8, row "Server load"): server CPU per board
 * page load, the API p95 under 10 parallel board loads against its idle value, and
 * the RSC and loopback requests each load causes.
 *
 * One process, one server, three phases, with an open-loop GET load on the board's
 * API routes running the whole time (fixed rate: a slow answer never delays the next
 * request, so queueing shows up in the latency):
 *
 *   idle        only the API load. Its API p95 is the idle value; its CPU per second
 *               is the baseline that is taken off every board load below.
 *   parallel    --parallel (default 10) `measure.mjs` runs at once, one cold board
 *               load each. The API p95 here is the loaded value.
 *   sequential  --loads (default 10) board loads one after the other, each its own
 *               `measure.mjs` run, so every load has its own CPU window.
 *
 * The server's CPU time is read just before a `measure.mjs` run starts and just after
 * it ends; the cost of a load is that window's CPU minus (idle CPU per second x the
 * window's seconds). A window holds the browser start and the 5.6 s `measure.mjs`
 * waits after the page settles, so it is longer than the load itself; the baseline
 * subtraction is what keeps the figure about the load. On a shared machine the
 * baseline moves: read the spread (`windows`) next to the p75.
 *
 * Usage (server on :3192 seeded by make-fixture.mjs; local only):
 *   node tests/perf/web-app/server-load.mjs --label m0-r1 [--pid <pid>] [--base http://127.0.0.1:3192]
 *     [--idle-seconds 30] [--rate 10] [--loads 10] [--parallel 10] [--profile desktop]
 *
 * Without --pid the server is the process that listens on the port of --base
 * (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`). Rows written to
 * tmp/perf/results/<label>-server-load.json (meta.tool "server-load"):
 *   board-load-cpu       { cpuMsPerLoad (p75 of the sequential windows), cpuMsPerLoadMedian,
 *                          cpuMsPerLoadParallel, cpuMsPerLoadTree, idleCpuMsPerSec, loads, rssMaxBytes, windows }
 *   api-p95              { idleP95Ms, loadedP95Ms (parallel phase), sequentialP95Ms, ratio, errors, rate }
 *   board-load-requests  { apiRequestsPerLoad, rscRequestsPerLoad, loopbackRequestsPerLoad }
 * The probe reports; gate.mjs decides. Exit 1 only when the probe could not run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fmt, median, parseArgs, percentile, readSeed, ROOT, startMeta, writeResult } from "./lib/common.mjs";
import { between, createSampler, pidsListeningOn, writeSamples } from "./lib/sampler.mjs";

const args = parseArgs();
const BASE = String(args.base ?? process.env.PERF_BASE ?? "http://127.0.0.1:3192").replace(/\/$/, "");
const OUT_DIR = String(args.out ?? "tmp/perf/results");
const LABEL = String(args.label ?? "run");
const IDLE_SECONDS = Number(args["idle-seconds"] ?? 30);
const WARMUP_SECONDS = Number(args["warmup-seconds"] ?? 3);
const RATE = Number(args.rate ?? 10);
const LOADS = Number(args.loads ?? 10);
const PARALLEL = Number(args.parallel ?? LOADS);
const PROFILE = String(args.profile ?? "desktop");
const MEASURE = path.join(ROOT, "tests/perf/web-app/measure.mjs");
const REQUEST_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

function refuseRemote(url) {
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(`server-load.mjs drives load and reads a local process: ${url.hostname} is not this machine. Point it at a local fixture.`);
  }
}

/** The GET requests the board page makes, read from one real load; a fixed list when that fails. */
async function boardGets(seed) {
  const fallback = ["/api/health", "issues", "sidebar-badges", "dashboard", "agents", "projects", "live-runs"].map((p) =>
    p.startsWith("/") ? p : `/api/companies/${seed.companyId}/${p}`,
  );
  const seen = new Set();
  const found = (source) => ({ urls: [...seen].slice(0, 24), source });
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(
        ([key]) => {
          try {
            localStorage.setItem(key, JSON.stringify({ viewMode: "board" }));
          } catch {}
        },
        [`paperclip:issues-view:${seed.companyId}`],
      );
      const page = await context.newPage();
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (r.method() === "GET" && u.pathname.startsWith("/api/") && ["fetch", "xhr"].includes(r.resourceType())) seen.add(u.pathname + u.search);
      });
      await page.goto(`${BASE}/${seed.prefix}/issues`, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(4000);
    } finally {
      await browser.close();
    }
    return seen.size ? found("board page") : { urls: fallback, source: "fixed list (the board page made no API GET)" };
  } catch (error) {
    return seen.size ? found("board page (partial)") : { urls: fallback, source: `fixed list (${String(error.message).split("\n")[0]})` };
  }
}

/** An open-loop GET generator: request i is issued at start + i / rate whatever happened to the earlier ones. */
function openLoopLoad(urls, rate) {
  const records = [];
  const inflight = new Set();
  const period = 1000 / rate;
  let phase = "warmup";
  let issued = 0;
  const startAt = performance.now();
  const fire = (url, scheduled) => {
    const t0 = performance.now();
    const rec = { phase, ms: null, ok: false, status: 0, lagMs: t0 - scheduled };
    const p = fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then(async (res) => {
        await res.arrayBuffer();
        rec.ms = performance.now() - t0;
        rec.status = res.status;
        rec.ok = res.status >= 200 && res.status < 300;
      })
      .catch(() => {
        rec.ms = performance.now() - t0;
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    records.push(rec);
  };
  const timer = setInterval(() => {
    const now = performance.now();
    while (startAt + issued * period <= now) {
      fire(urls[issued % urls.length], startAt + issued * period);
      issued += 1;
    }
  }, 10);
  return {
    setPhase: (name) => {
      phase = name;
    },
    async stop() {
      clearInterval(timer);
      await Promise.allSettled([...inflight]);
      return records;
    },
  };
}

function latencyStats(records, phase) {
  const mine = records.filter((r) => r.phase === phase);
  const ok = mine.filter((r) => r.ok).map((r) => r.ms);
  return {
    requests: mine.length,
    errors: mine.length - ok.length,
    p50: median(ok),
    p95: percentile(ok, 0.95),
    lagP95: percentile(mine.map((r) => r.lagMs), 0.95),
  };
}

/** One `measure.mjs` run of the board in a temporary output directory. Resolves with the run's result, if any. */
function boardLoad(tag, seedPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-load-"));
  const argv = [MEASURE, "--pages", "tasks-board", "--profiles", PROFILE, "--runs", "1", "--label", `${LABEL}-serverload-${tag}`, "--base", BASE, "--seed", seedPath, "--out", outDir];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      let result = null;
      try {
        for (const name of fs.readdirSync(outDir)) {
          if (!name.endsWith(".json")) continue;
          result = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8")).results?.[0] ?? null;
        }
      } catch {}
      fs.rmSync(outDir, { recursive: true, force: true });
      resolve({ ok: code === 0 && result !== null, code, result, error: code === 0 ? null : stderr.trim().split("\n").slice(-3).join(" | ") });
    });
  });
}

/** RSC requests of one load: a counter on the result if the measure run has one, else requests whose URL carries `_rsc`. */
function rscCount(result) {
  if (Number.isFinite(result?.rscRequests)) return result.rscRequests;
  const lists = [result?.apiCalls, Array.isArray(result?.requests) ? result.requests : null, result?.requestUrls];
  return lists.filter(Boolean).flat().filter((r) => /[?&]_rsc=?|\bRSC: ?1\b/.test(typeof r === "string" ? r : `${r.route ?? ""} ${r.url ?? ""} ${r.headers ? JSON.stringify(r.headers) : ""}`)).length;
}

async function measureWindow(sampler, label, work) {
  const from = await sampler.read();
  const outcome = await work();
  const to = await sampler.read();
  if (!from || !to) throw new Error("the server process went away while it was measured");
  return { label, outcome, ...between(from, to, sampler.samples) };
}

async function main() {
  const url = new URL(BASE);
  refuseRemote(url);
  const seedPath = path.resolve(String(args.seed ?? path.join(ROOT, "tmp/perf/seed-out.json")));
  const seed = readSeed(seedPath);
  const pids = args.pid ? [Number(args.pid)] : await pidsListeningOn(Number(url.port || 80));
  if (!pids.length || !pids[0]) throw new Error(`no process listens on port ${url.port}; start the fixture server or pass --pid`);
  const pid = pids[0];
  const meta = startMeta("server-load", args, { pid, rate: RATE, idleSeconds: IDLE_SECONDS, loads: LOADS, parallel: PARALLEL, profile: PROFILE, fixture: seed.counts });
  const sampler = createSampler({ pid, children: true });
  if (!(await sampler.read())) throw new Error(`process ${pid} is not running`);

  const { urls, source } = await boardGets(seed);
  console.error(`[server-load] pid ${pid}; ${urls.length} API routes from ${source}; ${RATE} req/s; idle ${IDLE_SECONDS}s, ${PARALLEL} parallel + ${LOADS} sequential board loads`);
  sampler.start();
  const load = openLoopLoad(urls, RATE);
  const windows = [];
  try {
    await sleep(WARMUP_SECONDS * 1000);
    load.setPhase("idle");
    const idle = await measureWindow(sampler, "idle", () => sleep(IDLE_SECONDS * 1000));
    const idleRate = idle.cpuMs / idle.seconds;
    const idleTreeRate = idle.treeCpuMs / idle.seconds;
    console.error(`[server-load] idle: ${fmt(idleRate)} ms CPU per second`);

    let parallel = null;
    if (PARALLEL > 0) {
      load.setPhase("parallel");
      parallel = await measureWindow(sampler, "parallel", () => Promise.all(times(PARALLEL, (i) => boardLoad(`par${i}`, seedPath))));
      console.error(`[server-load] parallel: ${parallel.outcome.filter((o) => o.ok).length}/${PARALLEL} loads in ${fmt(parallel.seconds, 1)} s`);
    }

    load.setPhase("sequential");
    for (let i = 0; i < LOADS; i += 1) {
      const w = await measureWindow(sampler, `seq${i}`, () => boardLoad(`seq${i}`, seedPath));
      windows.push({ ...w, netCpuMs: w.cpuMs - idleRate * w.seconds, netTreeCpuMs: w.treeCpuMs - idleTreeRate * w.seconds });
      console.error(`[server-load] load ${i + 1}/${LOADS}: ${fmt(w.seconds, 1)} s, cpu ${w.cpuMs} ms, net ${fmt(w.cpuMs - idleRate * w.seconds)} ms${w.outcome.ok ? "" : ` FAILED ${w.outcome.error ?? ""}`}`);
    }

    const records = await load.stop();
    await sampler.stop();
    writeSamples(path.join(OUT_DIR, `${LABEL}-server-load-samples.jsonl`), sampler.samples);

    const good = windows.filter((w) => w.outcome.ok);
    const loadResults = [...good.map((w) => w.outcome.result), ...(parallel?.outcome.filter((o) => o.ok).map((o) => o.result) ?? [])];
    const net = good.map((w) => w.netCpuMs);
    const netTree = good.map((w) => w.netTreeCpuMs);
    const parallelLoads = parallel?.outcome.filter((o) => o.ok).length ?? 0;
    const stats = { idle: latencyStats(records, "idle"), parallel: latencyStats(records, "parallel"), sequential: latencyStats(records, "sequential") };
    const rss = (key) => Math.max(...sampler.samples.map((s) => s[key]));
    const timedOut = loadResults.filter((r) => r.timedOut).length;

    const rows = [
      {
        key: "board-load-cpu",
        cpuMsPerLoad: net.length ? percentile(net, 0.75) : null,
        cpuMsPerLoadMedian: median(net),
        cpuMsPerLoadTree: netTree.length ? percentile(netTree, 0.75) : null,
        cpuMsPerLoadParallel: parallelLoads ? (parallel.cpuMs - idleRate * parallel.seconds) / parallelLoads : null,
        idleCpuMsPerSec: idleRate,
        loads: good.length,
        parallelLoads,
        failedLoads: windows.length - good.length + (PARALLEL - parallelLoads),
        timedOutLoads: timedOut,
        rssMaxBytes: rss("rssBytes"),
        treeRssMaxBytes: rss("treeRssBytes"),
        windows: windows.map((w) => ({ seconds: +w.seconds.toFixed(2), cpuMs: w.cpuMs, netCpuMs: +w.netCpuMs.toFixed(1), ok: w.outcome.ok })),
        note: "p75 of the sequential windows, net of the idle CPU rate; each window holds the browser start and the 5.6 s settle wait of measure.mjs",
      },
      {
        key: "api-p95",
        idleP95Ms: stats.idle.p95,
        loadedP95Ms: stats.parallel.p95,
        sequentialP95Ms: stats.sequential.p95,
        ratio: stats.idle.p95 && stats.parallel.p95 ? stats.parallel.p95 / stats.idle.p95 : null,
        idleP50Ms: stats.idle.p50,
        loadedP50Ms: stats.parallel.p50,
        requests: { idle: stats.idle.requests, parallel: stats.parallel.requests, sequential: stats.sequential.requests },
        errors: { idle: stats.idle.errors, parallel: stats.parallel.errors, sequential: stats.sequential.errors },
        scheduleLagP95Ms: percentile(records.map((r) => r.lagMs), 0.95),
        rate: RATE,
        routes: urls,
        routesFrom: source,
      },
      {
        key: "board-load-requests",
        loads: loadResults.length,
        apiRequestsPerLoad: median(loadResults.map((r) => r.apiRequests)),
        rscRequestsPerLoad: loadResults.length ? median(loadResults.map(rscCount)) : null,
        loopbackRequestsPerLoad: loadResults.length ? median(loadResults.map((r) => (Number.isFinite(r.loopbackRequests) ? r.loopbackRequests : 0))) : null,
        note: "RSC requests: a rscRequests counter on the measure result, else requests whose URL carries _rsc; loopback requests: a loopbackRequests counter on the measure result. Both are 0 before M0, which has no Next.js server.",
      },
    ];
    const file = writeResult(meta, { rows, results: windows.map((w) => ({ key: w.label, seconds: w.seconds, cpuMs: w.cpuMs, netCpuMs: w.netCpuMs, ok: w.outcome.ok, error: w.outcome.error ?? null })) }, OUT_DIR);
    const [cpu, api, req] = rows;
    console.log(`\n| row | value |\n|---|---|`);
    console.log(`| server CPU per board load (p75, net) | ${fmt(cpu.cpuMsPerLoad)} ms over ${cpu.loads} loads (median ${fmt(cpu.cpuMsPerLoadMedian)}, with children ${fmt(cpu.cpuMsPerLoadTree)}, parallel ${fmt(cpu.cpuMsPerLoadParallel)}) |`);
    console.log(`| idle CPU rate (with the API load) | ${fmt(cpu.idleCpuMsPerSec, 1)} ms/s |`);
    console.log(`| API p95 idle / ${PARALLEL} parallel loads / sequential | ${fmt(api.idleP95Ms, 1)} / ${fmt(api.loadedP95Ms, 1)} / ${fmt(api.sequentialP95Ms, 1)} ms (ratio ${fmt(api.ratio, 2)}) |`);
    console.log(`| API errors (idle / parallel / sequential) | ${api.errors.idle} / ${api.errors.parallel} / ${api.errors.sequential} of ${api.requests.idle} / ${api.requests.parallel} / ${api.requests.sequential} |`);
    console.log(`| requests per board load: API / RSC / loopback | ${fmt(req.apiRequestsPerLoad)} / ${fmt(req.rscRequestsPerLoad)} / ${fmt(req.loopbackRequestsPerLoad)} |`);
    console.log(`| server RSS max (process / with children) | ${fmt(cpu.rssMaxBytes / 1e6, 0)} MB / ${fmt(cpu.treeRssMaxBytes / 1e6, 0)} MB |`);
    if (cpu.failedLoads || cpu.timedOutLoads) console.log(`\n${cpu.failedLoads} board load(s) failed and ${cpu.timedOutLoads} timed out waiting for the page text; their windows are long and noisy.`);
    console.log(`\nresults: ${file}`);
    if (!good.length) {
      console.error("[server-load] no board load succeeded; the CPU row is empty");
      process.exitCode = 1;
    }
  } finally {
    await load.stop().catch(() => {});
    await sampler.stop().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(`[server-load] ${error.message}`);
  process.exitCode = 1;
}
