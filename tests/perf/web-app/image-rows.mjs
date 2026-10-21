/**
 * The image rows of plan section 8 (Memory, Start, Image and CI) on one CI runner, for the
 * `perf-image` workflow (plan section 15.4). Two commands:
 *
 *   build    Builds the production target of one arm (`--arm base|head`) from a source tree
 *            (`--context`), after emptying the BuildKit cache so that both arms start from the
 *            same state. Records the uncompressed image size (`docker image inspect`) and the
 *            build time in <work>/<arm>-build.json.
 *   measure  Starts a throwaway Postgres, then for each round (default 2) and each arm, with
 *            the order alternating between rounds, runs the arm's image under the compose
 *            limits and records:
 *              - `start-timer.mjs`, --restarts times (default 5): process start to
 *                `/api/health` ok and to the first UI 200, the startup peak (VmHWM), OOMKilled;
 *              - 10 parallel cold loads of `/` and its scripts and styles, --waves times;
 *              - the steady-state resident memory after the loads.
 *            One round writes <out>/<label>-r<N>-image.json (rows `image` and `container`, every
 *            row tagged with `arm`) and <out>/<label>-r<N>-start-timer.json (tagged the same
 *            way), which gate.mjs reads as they are: `gate.mjs --slice image-ci --base <out>
 *            --head <out>`. The probe reports; gate.mjs decides. The exit code is 1 only when
 *            an arm could not be measured at all.
 *
 * The container runs as the compose service does (`deploy/compose.yaml`): `--memory 2g
 * --memory-swap 2g`, 2 CPUs, 256 pids, NODE_OPTIONS=--max-old-space-size=1536, the same
 * environment, in the image's default `authenticated` mode. Two things differ on purpose:
 * secrets are not strict (there is no master key file, and nothing stores a secret), and the
 * state lives in a fresh named volume and a fresh database per arm and round. Read-only root,
 * dropped capabilities and the ingress are left out: they do not change what the memory,
 * start and size rows measure.
 *
 * Usage (from the repository root, with Docker; node:* built-ins only):
 *   node tests/perf/web-app/image-rows.mjs build --arm base --context ../base --commit <sha>
 *   node tests/perf/web-app/image-rows.mjs build --arm head --context . --commit <sha>
 *   node tests/perf/web-app/image-rows.mjs measure --label ci [--rounds 2] [--restarts 5]
 *     [--waves 3] [--parallel 10] [--port 3100] [--settle-s 15] [--out tmp/perf/results]
 *     [--work tmp/perf/image] [--deadline-epoch <unix seconds>]
 *
 * `DOCKER_BIN` names another docker executable (a test double). With $GITHUB_STEP_SUMMARY set,
 * `measure` appends its tables to the job summary.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fmt, median, parseArgs, percentile, startMeta, writeResult } from "./lib/common.mjs";
import { NODE_STATUS, parseNodeStatus, timeReady } from "./start-timer.mjs";

const DOCKER = process.env.DOCKER_BIN ?? "docker";
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Same build arguments as .github/workflows/image-build-check.yml, for both arms. */
const BUILD_VERSION = "2026.1001.0-vllnt";
/** deploy/compose.yaml pins this digest for `postgres:17-alpine`; mirror.gcr.io serves the same one (the Dockerfile header says why not docker.io). */
const POSTGRES_IMAGE = "mirror.gcr.io/library/postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const NETWORK = "perf-image-net";
const DB_CONTAINER = "perf-image-db";
const FIRST_BOOT_TIMEOUT_MS = 300_000;

const docker = (argv, options = {}) => run(DOCKER, argv, { maxBuffer: 64 * 1024 * 1024, ...options });
const quietDocker = (argv) => docker(argv).catch(() => null);
const note = (text) => console.error(`[image-rows] ${text}`);
const armOf = (args) => {
  if (args.arm !== "base" && args.arm !== "head") throw new Error("--arm must be base or head");
  return args.arm;
};

/* build */

async function build(args) {
  const arm = armOf(args);
  if (typeof args.context !== "string") throw new Error("--context <source tree> is required");
  const context = path.resolve(args.context);
  if (!fs.existsSync(path.join(context, "Dockerfile"))) throw new Error(`no Dockerfile in ${context}`);
  const work = String(args.work ?? "tmp/perf/image");
  const tag = `perf-${arm}:ci`;
  // The BuildKit cache is emptied before each arm: the second build would otherwise reuse the first one's layers.
  await quietDocker(["buildx", "prune", "--all", "--force"]);
  const argv = [
    "buildx", "build", "--load", "--progress", "plain",
    "--target", "production", "--platform", "linux/amd64",
    "--build-arg", `PAPERCLIP_BUILD_COMMIT=${args.commit ?? ""}`,
    "--build-arg", `PAPERCLIP_BUILD_VERSION=${BUILD_VERSION}`,
    "--build-arg", "INSTALL_LOCAL_CLIS=false",
    "--tag", tag, context,
  ];
  note(`${arm}: docker ${argv.join(" ")}`);
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(DOCKER, argv, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`docker buildx build exited with ${code}`))));
  });
  const buildSeconds = Math.round((performance.now() - t0) / 100) / 10;
  const sizeBytes = Number((await docker(["image", "inspect", "-f", "{{.Size}}", tag])).stdout.trim());
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error(`docker image inspect gave no size for ${tag}`);
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, `${arm}-build.json`);
  fs.writeFileSync(file, JSON.stringify({ arm, tag, commit: args.commit ?? null, sizeBytes, buildSeconds, at: new Date().toISOString() }, null, 2));
  note(`${arm}: ${fmt(sizeBytes / 1e6)} MB, built in ${fmt(buildSeconds)} s (${file})`);
}

/* measure */

const PASSWORD = crypto.randomBytes(12).toString("hex");

async function startPostgres() {
  await docker(["pull", "--quiet", POSTGRES_IMAGE]);
  await docker(["network", "create", NETWORK]);
  // The compose limits for the database: 1 CPU, 1 GB.
  await docker(["run", "-d", "--name", DB_CONTAINER, "--network", NETWORK, "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--shm-size", "128m",
    "-e", "POSTGRES_DB=paperclip", "-e", "POSTGRES_USER=paperclip", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, POSTGRES_IMAGE]);
  for (let i = 0; i < 90; i += 1) {
    if (await quietDocker(["exec", DB_CONTAINER, "pg_isready", "-U", "paperclip", "-d", "paperclip"])) return;
    await sleep(1000);
  }
  throw new Error("the throwaway Postgres did not become ready in 90 s");
}

async function stopPostgres() {
  await quietDocker(["rm", "-f", "-v", DB_CONTAINER]);
  await quietDocker(["network", "rm", NETWORK]);
}

function appArgs({ name, image, database, volume, port }) {
  const env = {
    HOST: "0.0.0.0",
    PORT: "3100",
    SERVE_UI: "true",
    PAPERCLIP_BIND: "custom",
    PAPERCLIP_BIND_HOST: "0.0.0.0",
    PAPERCLIP_HOME: "/paperclip",
    DATABASE_URL: `postgres://paperclip:${PASSWORD}@${DB_CONTAINER}:5432/${database}`,
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: crypto.randomBytes(24).toString("hex"),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: crypto.randomBytes(24).toString("hex"),
    PAPERCLIP_SECRETS_STRICT_MODE: "false",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    NODE_OPTIONS: "--max-old-space-size=1536",
  };
  return [
    "run", "-d", "--name", name, "--network", NETWORK, "-p", `127.0.0.1:${port}:3100`,
    "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
    "-v", `${volume}:/paperclip`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
  ];
}

async function containerState(name) {
  const { stdout } = await docker(["inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}} {{.State.ExitCode}}", name]);
  const [running, oom, restarts, exitCode] = stdout.trim().split(" ");
  return { running: running === "true", oomKilled: oom === "true", restartCount: Number(restarts), exitCode: Number(exitCode) };
}

async function serverProcesses(name) {
  try {
    return parseNodeStatus((await docker(["exec", name, "sh", "-c", NODE_STATUS])).stdout);
  } catch {
    return null;
  }
}

/** `<script src>`, `<link href>` of scripts and styles, as absolute URLs of the same origin. */
export function assetUrls(html, base) {
  const origin = new URL(base).origin;
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:m?js|css)(?:\?[^"']*)?)["']/g)) {
    try {
      const url = new URL(match[1], `${base}/`);
      if (url.origin === origin) found.add(url.href);
    } catch {
      /* not a URL */
    }
  }
  return [...found];
}

/** One cold page load without a browser: the document, then every script and style it names. */
async function coldLoad(base) {
  const t0 = performance.now();
  const fetchOnce = async (url) => {
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    } catch {
      return { status: 0, body: Buffer.alloc(0) };
    }
  };
  const doc = await fetchOnce(`${base}/`);
  const assets = await Promise.all(assetUrls(doc.body.toString("utf8"), base).map(fetchOnce));
  const requests = 1 + assets.length;
  const failed = [doc, ...assets].filter((r) => r.status !== 200).length;
  return { ms: performance.now() - t0, requests, failed };
}

async function loadWave(base, name, parallel) {
  let peakRssBytes = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const now = await serverProcesses(name);
      if (now?.rssBytes) peakRssBytes = Math.max(peakRssBytes, now.rssBytes);
      await sleep(1000);
    }
  })();
  const loads = await Promise.all(Array.from({ length: parallel }, () => coldLoad(base)));
  sampling = false;
  await sampler;
  return { loads, peakRssBytes };
}

async function firstBoot(name, base) {
  const t0 = performance.now();
  while (performance.now() - t0 < FIRST_BOOT_TIMEOUT_MS) {
    const at = performance.now();
    const ready = await timeReady(base, at, 15_000);
    if (ready.apiReadyMs !== null && ready.firstUiMs !== null) return true;
    if (!(await containerState(name)).running) return false;
  }
  return false;
}

function runStartTimer({ name, base, restarts, label, out }) {
  return new Promise((resolve) => {
    const argv = [path.join(HERE, "start-timer.mjs"), "--docker", name, "--url", base, "--runs", String(restarts), "--settle-ms", "3000", "--label", label, "--out", out];
    const child = spawn(process.execPath, argv, { stdio: ["ignore", 2, 2] });
    child.on("error", () => resolve(null));
    child.on("exit", () => {
      const file = path.join(out, `${label}-start-timer.json`);
      try {
        resolve(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Runs one arm in a fresh container, volume and database. Never throws; a failure is in the row. */
async function measureArm({ arm, round, build: built, options, label }) {
  const name = `perf-image-${arm}`;
  const volume = `perf-image-home-${arm}-r${round}`;
  const database = `perf_${arm}_r${round}`;
  const base = `http://127.0.0.1:${options.port}`;
  const row = { arm, key: "container", round, image: built.tag, steadyRssBytes: null, startupPeakBytes: null, oomKilled: false, restartCount: 0 };
  let start = null;
  const logFile = path.join(options.work, "logs", `${arm}-r${round}.log`);
  try {
    await quietDocker(["rm", "-f", name]);
    await docker(["exec", DB_CONTAINER, "psql", "-U", "paperclip", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`]);
    await docker(["volume", "create", volume]);
    await docker(appArgs({ name, image: built.tag, database, volume, port: options.port }));
    note(`${arm} round ${round}: container started, waiting for the first boot (migrations)`);
    if (!(await firstBoot(name, base))) {
      row.failed = "the server did not reach /api/health ok and a UI 200 on its first boot";
      row.oomKilled = (await containerState(name).catch(() => ({}))).oomKilled === true;
      return { row, start };
    }
    const first = await serverProcesses(name);
    row.firstBootPeakBytes = first?.startupPeakBytes ?? null;

    start = await runStartTimer({ name, base, restarts: options.restarts, label: `${label}-r${round}-${arm}`, out: path.join(options.work, "start") });
    const startRow = start?.rows?.[0];
    row.restartsReached = startRow?.reached ?? 0;
    row.startupPeakBytes = startRow?.startupPeakBytes ?? null;
    row.startupPeakBytesMax = startRow?.startupPeakBytesMax ?? null;
    row.serverProcesses = start?.results?.[0]?.serverProcesses ?? null;
    if (!startRow?.reached) row.failed = "no restart reached /api/health ok and a UI 200";

    // Loads run on the server as the last restart left it.
    const idle = await serverProcesses(name);
    row.idleRssBytes = idle?.rssBytes ?? null;
    const loads = [];
    for (let wave = 1; wave <= options.waves; wave += 1) {
      const result = await loadWave(base, name, options.parallel);
      loads.push(...result.loads);
      row.loadPeakRssBytes = Math.max(row.loadPeakRssBytes ?? 0, result.peakRssBytes);
      note(`${arm} round ${round}: wave ${wave}/${options.waves} — ${result.loads.length} loads, ${result.loads.reduce((n, l) => n + l.failed, 0)} failed requests`);
    }
    row.loads = loads.length;
    row.loadRequests = loads.reduce((n, l) => n + l.requests, 0);
    row.loadFailedRequests = loads.reduce((n, l) => n + l.failed, 0);
    row.loadP95Ms = percentile(loads.map((l) => l.ms), 0.95);

    await sleep(options.settleS * 1000);
    const samples = [];
    for (let i = 0; i < 10; i += 1) {
      const now = await serverProcesses(name);
      if (now?.rssBytes) samples.push(now.rssBytes);
      await sleep(2000);
    }
    row.steadyRssBytes = median(samples);
    row.steadySamples = samples.length;
    row.peakAfterLoadsBytes = (await serverProcesses(name))?.startupPeakBytes ?? null;

    const after = await containerState(name);
    row.restartCount = after.restartCount;
    row.oomKilled = Boolean(startRow?.oomKilled) || after.oomKilled;
    if (!after.running) row.failed = `the container stopped during the loads (exit code ${after.exitCode})`;
    return { row, start };
  } catch (error) {
    row.failed = String(error.message).split("\n")[0];
    return { row, start };
  } finally {
    const logs = await quietDocker(["logs", "--tail", "300", name]);
    if (logs) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${logs.stdout}${logs.stderr}`);
    }
    await quietDocker(["rm", "-f", name]);
    await quietDocker(["volume", "rm", "-f", volume]);
  }
}

const tagged = (arm, items) => (items ?? []).map((item) => ({ arm, ...item }));
const mb = (bytes) => (bytes == null ? "-" : fmt(bytes / 1e6));

function summaryMarkdown(builds, containers, startRows) {
  const out = ["### Image rows (same runner, base then head)", "", "| arm | image size | build time |", "|---|---|---|"];
  for (const arm of ["base", "head"]) out.push(`| ${arm} | ${mb(builds[arm].sizeBytes)} MB | ${fmt(builds[arm].buildSeconds)} s |`);
  out.push("", "| arm | round | steady RSS | startup peak | peak after loads | first UI (median) | API ready (median) | OOM | note |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of containers) {
    const s = startRows.find((r) => r.arm === c.arm && r.round === c.round);
    out.push(`| ${c.arm} | ${c.round} | ${mb(c.steadyRssBytes)} MB | ${mb(c.startupPeakBytes)} MB | ${mb(c.peakAfterLoadsBytes)} MB | ${fmt(s?.firstUiMs)} ms | ${fmt(s?.apiReadyMs)} ms | ${c.oomKilled ? "**yes**" : "no"} | ${c.failed ?? ""} |`);
  }
  return out.join("\n");
}

async function measure(args) {
  const options = {
    rounds: Number(args.rounds ?? 2),
    restarts: Number(args.restarts ?? 5),
    waves: Number(args.waves ?? 3),
    parallel: Number(args.parallel ?? 10),
    port: Number(args.port ?? 3100),
    settleS: Number(args["settle-s"] ?? 15),
    out: String(args.out ?? "tmp/perf/results"),
    work: String(args.work ?? "tmp/perf/image"),
  };
  const label = String(args.label ?? "ci");
  const deadline = args["deadline-epoch"] ? Number(args["deadline-epoch"]) : null;
  const builds = {};
  for (const arm of ["base", "head"]) builds[arm] = JSON.parse(fs.readFileSync(path.join(options.work, `${arm}-build.json`), "utf8"));

  const containers = [];
  const startRows = [];
  let failed = false;
  await startPostgres();
  try {
    let roundSeconds = 0;
    for (let round = 1; round <= options.rounds; round += 1) {
      // A later round starts only when the time budget has room for one as long as the first.
      if (round > 1 && deadline && Date.now() / 1000 + roundSeconds * 1.2 > deadline) {
        note(`round ${round} skipped: ${fmt(deadline - Date.now() / 1000)} s left, a round took ${fmt(roundSeconds)} s`);
        break;
      }
      const startedAt = Date.now();
      const imageMeta = startMeta("image", { label: `${label}-r${round}` }, { round, restarts: options.restarts, waves: options.waves, parallel: options.parallel });
      const startMetaDoc = startMeta("start-timer", { label: `${label}-r${round}` }, { mode: "docker", round, runs: options.restarts });
      const imageRows = round === 1 ? ["base", "head"].map((arm) => ({ arm, key: "image", tag: builds[arm].tag, commit: builds[arm].commit, sizeBytes: builds[arm].sizeBytes, buildSeconds: builds[arm].buildSeconds })) : [];
      const roundStart = { rows: [], results: [] };
      for (const arm of round % 2 === 1 ? ["base", "head"] : ["head", "base"]) {
        const { row, start } = await measureArm({ arm, round, build: builds[arm], options, label });
        if (row.failed) {
          failed = true;
          note(`${arm} round ${round} FAILED: ${row.failed}`);
        }
        containers.push(row);
        imageRows.push(row);
        if (start) {
          const rows = tagged(arm, start.rows).map((r) => ({ ...r, round }));
          roundStart.rows.push(...rows);
          roundStart.results.push(...tagged(arm, start.results));
          startRows.push(...rows);
        }
        // Written after each arm, so a crash later keeps what was measured.
        writeResult(imageMeta, { rows: imageRows }, options.out);
        writeResult(startMetaDoc, roundStart, options.out);
      }
      roundSeconds = (Date.now() - startedAt) / 1000;
    }
  } finally {
    await stopPostgres();
  }

  const markdown = summaryMarkdown(builds, containers, startRows);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "build") await build(parseArgs(rest));
    else if (command === "measure") await measure(parseArgs(rest));
    else throw new Error("usage: image-rows.mjs build --arm base|head --context <dir> --commit <sha> | measure --label <label>");
  } catch (error) {
    console.error(`[image-rows] ${error.message}`);
    process.exitCode = 1;
  }
}
