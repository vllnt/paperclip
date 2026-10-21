/**
 * Start timer (plan section 8, row "Start"): how long a server takes from the start
 * command to `/api/health` with `status: "ok"` and to the first UI 200 (`GET /`).
 * `tests/perf/backend/lib/server.mjs` times only a process it starts itself, with the
 * UI off and its own port, so it cannot give the UI figure; this timer polls both URLs
 * every 100 ms from the same start.
 *
 * Two modes, each run starts from a stopped server:
 *
 *   --docker <container>   `docker stop`, then `docker start` and poll. The container
 *                          must exist, publish port 3100 (or pass --url), and keep its
 *                          state between runs. After the last run it is left running.
 *                          After the first UI 200 it waits --settle-ms (default 3000),
 *                          then reads VmHWM (the startup peak) and VmRSS from /proc inside
 *                          the container, summed over every process except PID 1 (tini)
 *                          and the exec's own shell, so a second server process counts.
 *                          OOMKilled and RestartCount come from `docker inspect`.
 *   --cmd "<command>"      Run a shell command that starts the server on --base (the
 *                          command's own port and environment), time it, then stop its
 *                          process group. Refuses to run when something already answers
 *                          at --base. VmHWM is read on Linux only; elsewhere it is null.
 *
 * Usage:
 *   node tests/perf/web-app/start-timer.mjs --docker perf-app --label ci-base --runs 5
 *   node tests/perf/web-app/start-timer.mjs --cmd "PORT=3195 node server.js" --base http://127.0.0.1:3195
 *
 * Writes tmp/perf/results/<label>-start-timer.json (meta.tool "start-timer"): `results`
 * has one { key: "start", run, apiReadyMs, firstUiMs, startupPeakBytes, ... } per run and
 * `rows` one { key: "start", ... } with the medians and maxima. The probe reports;
 * gate.mjs decides. Exit 1 only when no run reached an answer.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fmt, median, parseArgs, startMeta, writeResult } from "./lib/common.mjs";
import { pidsListeningOn, readProcess } from "./lib/sampler.mjs";

const run = promisify(execFile);
const args = parseArgs();
const DOCKER = process.env.DOCKER_BIN ?? "docker";
const RUNS = Number(args.runs ?? 5);
const SETTLE_MS = Number(args["settle-ms"] ?? 3000);
const TIMEOUT_MS = Number(args["timeout-s"] ?? 180) * 1000;
const POLL_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(url, accept) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const ok = await accept(res);
    await res.arrayBuffer().catch(() => {});
    return ok;
  } catch {
    return false;
  }
}
const healthOk = (base) => probe(`${base}/api/health`, async (res) => res.ok && (await res.clone().json().catch(() => null))?.status === "ok");
const uiOk = (base) => probe(`${base}/`, (res) => res.status === 200);

/** Polls both URLs until each has answered once; times are milliseconds since `t0`. */
export async function timeReady(base, t0, timeoutMs = TIMEOUT_MS) {
  let apiReadyMs = null;
  let firstUiMs = null;
  while (performance.now() - t0 < timeoutMs && (apiReadyMs === null || firstUiMs === null)) {
    const [api, ui] = await Promise.all([apiReadyMs === null ? healthOk(base) : null, firstUiMs === null ? uiOk(base) : null]);
    const now = performance.now() - t0;
    if (api) apiReadyMs = now;
    if (ui) firstUiMs = now;
    if (apiReadyMs === null || firstUiMs === null) await sleep(POLL_MS);
  }
  return { apiReadyMs, firstUiMs };
}

/* docker mode */

const docker = (...argv) => run(DOCKER, argv, { maxBuffer: 8 * 1024 * 1024 });

async function baseUrlOf(container) {
  if (typeof args.url === "string") return args.url.replace(/\/$/, "");
  const { stdout } = await docker("port", container, "3100/tcp");
  const first = stdout.trim().split("\n")[0];
  if (!first) throw new Error(`container ${container} publishes no port 3100; pass --url`);
  return `http://${first.replace(/^0\.0\.0\.0|^\[::\]/, "127.0.0.1")}`;
}

/** Every process of the container except PID 1 (tini) and the shell and tools of this very `docker exec`. */
export const NODE_STATUS = `for d in /proc/[0-9]*; do pid=\${d#/proc/}; [ "$pid" = 1 ] && continue; comm=$(cat $d/comm 2>/dev/null) || continue; case "$comm" in sh|cat|grep) continue;; esac; echo "pid $pid $comm"; grep -E '^(VmHWM|VmRSS):' $d/status 2>/dev/null; done`;

/**
 * VmHWM and VmRSS (bytes) summed over the processes the shell loop printed. A second server
 * process (the Next.js process of the migration) must count, or the memory rows would miss
 * exactly the memory the migration adds. The sum of the peaks is an upper bound of the
 * container's peak, since the processes need not peak together.
 */
export function parseNodeStatus(text) {
  const procs = [];
  for (const line of text.split("\n")) {
    const head = /^pid (\d+)(?: (.*))?$/.exec(line);
    if (head) procs.push({ pid: Number(head[1]), comm: head[2] ?? null });
    const vm = /^(VmHWM|VmRSS):\s+(\d+) kB/.exec(line);
    if (vm && procs.length) procs.at(-1)[vm[1]] = Number(vm[2]) * 1024;
  }
  // A process that exited between the listing and the read has no figures.
  const live = procs.filter((p) => p.VmHWM !== undefined && p.VmRSS !== undefined).sort((a, b) => a.pid - b.pid);
  if (!live.length) return { startupPeakBytes: null, rssBytes: null, processes: [] };
  const sum = (key) => live.reduce((total, p) => total + p[key], 0);
  return {
    startupPeakBytes: sum("VmHWM"),
    rssBytes: sum("VmRSS"),
    processes: live.map((p) => ({ pid: p.pid, comm: p.comm, hwmBytes: p.VmHWM, rssBytes: p.VmRSS })),
  };
}

async function dockerRun(container, base) {
  await docker("stop", "-t", "30", container).catch(() => {});
  for (let i = 0; i < 60; i += 1) {
    const { stdout } = await docker("inspect", "-f", "{{.State.Running}}", container);
    if (stdout.trim() === "false") break;
    await sleep(500);
  }
  const t0 = performance.now();
  await docker("start", container);
  const times = await timeReady(base, t0);
  let status = { startupPeakBytes: null, rssBytes: null, processes: [] };
  if (times.apiReadyMs !== null && times.firstUiMs !== null) {
    await sleep(SETTLE_MS);
    try {
      status = parseNodeStatus((await docker("exec", container, "sh", "-c", NODE_STATUS)).stdout);
    } catch (error) {
      status.error = String(error.message).split("\n")[0];
    }
  }
  const { stdout } = await docker("inspect", "-f", "{{.State.OOMKilled}} {{.RestartCount}} {{.State.ExitCode}}", container);
  const [oom, restarts, exitCode] = stdout.trim().split(" ");
  return { ...times, startupPeakBytes: status.startupPeakBytes, rssAtSettleBytes: status.rssBytes, serverProcesses: status.processes.length, oomKilled: oom === "true", restartCount: Number(restarts), exitCode: Number(exitCode), ...(status.error ? { statusError: status.error } : {}) };
}

/* command mode */

async function stopGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 20_000);
  await gone;
  clearTimeout(timer);
}

function linuxHwm(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = /^VmHWM:\s+(\d+) kB/m.exec(status);
    return kb ? Number(kb[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function commandRun(command, base) {
  if (await healthOk(base)) throw new Error(`something already answers at ${base}; stop it, or the timer would measure a server it did not start`);
  const t0 = performance.now();
  const child = spawn("sh", ["-c", command], { detached: true, stdio: ["ignore", "ignore", "pipe"], cwd: typeof args.cwd === "string" ? args.cwd : process.cwd() });
  let tail = "";
  child.stderr.on("data", (d) => {
    tail = (tail + d).slice(-1500);
  });
  let times;
  try {
    times = await timeReady(base, t0);
    let startupPeakBytes = null;
    let rssAtSettleBytes = null;
    if (times.apiReadyMs !== null && times.firstUiMs !== null) {
      await sleep(SETTLE_MS);
      const [pid] = await pidsListeningOn(Number(new URL(base).port));
      if (pid) {
        rssAtSettleBytes = (await readProcess(pid))?.rssBytes ?? null;
        startupPeakBytes = linuxHwm(pid);
      }
    }
    return { ...times, startupPeakBytes, rssAtSettleBytes, oomKilled: false, restartCount: 0, exitCode: null, ...(times.apiReadyMs === null ? { error: tail.trim().split("\n").slice(-2).join(" | ") } : {}) };
  } finally {
    await stopGroup(child);
    for (let i = 0; i < 40 && (await healthOk(base)); i += 1) await sleep(250);
  }
}

async function main() {
  const container = typeof args.docker === "string" ? args.docker : null;
  const command = typeof args.cmd === "string" ? args.cmd : null;
  if (!container === !command) throw new Error('give exactly one of --docker <container> or --cmd "<command>" (with --base)');
  const base = container ? await baseUrlOf(container) : String(args.base ?? "").replace(/\/$/, "");
  if (!base) throw new Error("--cmd needs --base <url the command serves>");
  const meta = startMeta("start-timer", { ...args, base }, { mode: container ? "docker" : "cmd", target: container ?? command, runs: RUNS, settleMs: SETTLE_MS });
  const results = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = container ? await dockerRun(container, base) : await commandRun(command, base);
    results.push({ key: "start", run: i, ...r });
    console.error(`[start-timer] run ${i + 1}/${RUNS}: api ${fmt(r.apiReadyMs)} ms, ui ${fmt(r.firstUiMs)} ms, peak ${r.startupPeakBytes === null ? "-" : fmt(r.startupPeakBytes / 1e6)} MB${r.oomKilled ? " OOMKILLED" : ""}`);
  }
  const values = (field) => results.map((r) => r[field]);
  const maxOf = (field) => (values(field).some((v) => v !== null && v !== undefined) ? Math.max(...values(field).filter((v) => v !== null && v !== undefined)) : null);
  const rows = [
    {
      key: "start",
      runs: RUNS,
      reached: results.filter((r) => r.apiReadyMs !== null && r.firstUiMs !== null).length,
      apiReadyMs: median(values("apiReadyMs")),
      firstUiMs: median(values("firstUiMs")),
      apiReadyMsMax: maxOf("apiReadyMs"),
      firstUiMsMax: maxOf("firstUiMs"),
      startupPeakBytes: median(values("startupPeakBytes")),
      startupPeakBytesMax: maxOf("startupPeakBytes"),
      oomKilled: results.some((r) => r.oomKilled),
    },
  ];
  const file = writeResult(meta, { rows, results }, String(args.out ?? "tmp/perf/results"));
  console.log(`| runs | api ready (median / max) | first UI (median / max) | startup peak (median) | OOM |\n|---|---|---|---|---|`);
  const [row] = rows;
  console.log(`| ${row.reached}/${RUNS} | ${fmt(row.apiReadyMs)} / ${fmt(row.apiReadyMsMax)} ms | ${fmt(row.firstUiMs)} / ${fmt(row.firstUiMsMax)} ms | ${row.startupPeakBytes === null ? "-" : `${fmt(row.startupPeakBytes / 1e6)} MB`} | ${row.oomKilled ? "yes" : "no"} |`);
  console.log(`\nresults: ${file}`);
  if (!row.reached) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[start-timer] ${error.message}`);
    process.exitCode = 1;
  }
}
