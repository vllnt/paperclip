/**
 * One-second CPU and resident-memory sampler for a local process (and, on request,
 * its children). macOS and Linux, Node built-ins only.
 *
 * Plan section 7 asks for server-side numbers (CPU per page load, RSS) from a
 * sampler that this plan builds itself: #115's backend harness has no one-second
 * sampler (`probe-preload.mjs`), so this is the one used by server-load.mjs.
 *
 *   macOS   `ps -o rss=,time= -p <pid>` (CPU time resolution 10 ms); with children
 *           `ps -A -o pid=,ppid=,rss=,time=` once per sample
 *   Linux   /proc/<pid>/stat (utime + stime, clock ticks) and its resident pages
 *
 * A sample is { t, cpuMs, rssBytes, treeCpuMs, treeRssBytes, treePids }: `cpu*` is
 * the process alone, `tree*` the process plus its live descendants (equal to the
 * process alone when children are not asked for). CPU time is cumulative, so the
 * CPU spent in a window is the difference of two samples; a descendant that exited
 * inside the window is not in the later sample, which can make the tree delta
 * smaller than the truth. The process alone does not have that gap.
 *
 * CLI (to try it by hand):
 *   node tests/perf/web-app/lib/sampler.mjs --pid 1234 --seconds 5 [--children] [--out samples.jsonl]
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "./common.mjs";

const run = promisify(execFile);
const IS_LINUX = process.platform === "linux";

/** `[[dd-]hh:]mm:ss[.cc]` and macOS `mmm:ss.cc` → milliseconds. */
export function parseCpuTime(text) {
  let rest = String(text).trim();
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return Math.round((seconds + days * 86400) * 1000);
}

const sysconf = (name, fallback) => {
  try {
    const n = Number(execFileSync("getconf", [name], { encoding: "utf8" }).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
};
const LINUX = IS_LINUX ? { tick: sysconf("CLK_TCK", 100), page: sysconf("PAGESIZE", 4096) } : null;

function readLinuxProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(f[1]), cpuMs: Math.round(((Number(f[11]) + Number(f[12])) * 1000) / LINUX.tick), rssBytes: Number(f[21]) * LINUX.page };
  } catch {
    return null;
  }
}

async function readTable() {
  const table = new Map();
  if (IS_LINUX) {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const p = readLinuxProc(Number(name));
      if (p) table.set(p.pid, p);
    }
    return table;
  }
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { maxBuffer: 16 * 1024 * 1024 });
  for (const line of stdout.split("\n")) {
    const [pid, ppid, rssKb, time] = line.trim().split(/\s+/);
    const cpuMs = parseCpuTime(time ?? "");
    if (pid && cpuMs !== null) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), cpuMs, rssBytes: Number(rssKb) * 1024 });
  }
  return table;
}

async function readOne(pid) {
  if (IS_LINUX) return readLinuxProc(pid);
  try {
    const { stdout } = await run("ps", ["-o", "rss=,time=", "-p", String(pid)]);
    const [rssKb, time] = stdout.trim().split(/\s+/);
    const cpuMs = parseCpuTime(time ?? "");
    return rssKb && cpuMs !== null ? { pid, cpuMs, rssBytes: Number(rssKb) * 1024 } : null;
  } catch {
    return null;
  }
}

/** One reading of a process, or null when it is gone. */
export async function readProcess(pid, { children = false } = {}) {
  const t = Date.now();
  if (!children) {
    const p = await readOne(pid);
    return p && { t, cpuMs: p.cpuMs, rssBytes: p.rssBytes, treeCpuMs: p.cpuMs, treeRssBytes: p.rssBytes, treePids: [pid] };
  }
  const table = await readTable();
  const root = table.get(pid);
  if (!root) return null;
  const tree = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table.values()) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  const members = [...tree].map((id) => table.get(id));
  return {
    t,
    cpuMs: root.cpuMs,
    rssBytes: root.rssBytes,
    treeCpuMs: members.reduce((s, p) => s + p.cpuMs, 0),
    treeRssBytes: members.reduce((s, p) => s + p.rssBytes, 0),
    treePids: [...tree],
  };
}

/** Takes a sample every `intervalMs` until `stop()`. A slow `ps` skips a tick instead of piling up. */
export function createSampler({ pid, intervalMs = 1000, children = false }) {
  const samples = [];
  let timer = null;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await readProcess(pid, { children });
      if (s) samples.push(s);
    } finally {
      busy = false;
    }
  };
  return {
    samples,
    read: () => readProcess(pid, { children }),
    start() {
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (stopped) return samples;
      stopped = true;
      clearInterval(timer);
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
      await tick();
      return samples;
    },
  };
}

/** CPU spent and peak resident memory between two readings of the same process. */
export function between(from, to, samples = []) {
  const inside = samples.filter((s) => s.t >= from.t && s.t <= to.t);
  const peak = (key) => Math.max(from[key], to[key], ...inside.map((s) => s[key]));
  return {
    seconds: (to.t - from.t) / 1000,
    cpuMs: to.cpuMs - from.cpuMs,
    treeCpuMs: to.treeCpuMs - from.treeCpuMs,
    rssMaxBytes: peak("rssBytes"),
    treeRssMaxBytes: peak("treeRssBytes"),
    samples: inside.length,
  };
}

export function writeSamples(file, samples) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""));
}

/** The pids that listen on a TCP port of this machine (empty when none, or when lsof is missing). */
export async function pidsListeningOn(port) {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return [...new Set(stdout.split("\n").filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const pid = Number(args.pid);
  if (!pid) {
    console.error("usage: node lib/sampler.mjs --pid <pid> [--seconds 5] [--children] [--out samples.jsonl]");
    process.exit(2);
  }
  const sampler = createSampler({ pid, children: args.children === true });
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, Number(args.seconds ?? 5) * 1000));
  const samples = await sampler.stop();
  for (const s of samples) console.log(JSON.stringify(s));
  if (typeof args.out === "string") writeSamples(args.out, samples);
}
