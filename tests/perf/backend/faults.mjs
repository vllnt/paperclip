/**
 * Fault runs of doc/plans/2026-10-10-backend-effect.md, section 8.
 *
 *   F1, helper level, no server: a real query through
 *   `retryIdempotentDatabaseOperation` at a fixed call rate (open loop) while a
 *   chaos loop ends the database backends every 25 ms for a set length, and a
 *   slow-failure case in which a TCP proxy stalls every connection for 3 s and
 *   then resets it. Two or more helper versions ("arms") run in interleaved
 *   trials against one embedded Postgres.
 *
 * Run with the tsx loader of a checkout whose dependencies are installed:
 *
 *   node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs f1 \
 *     --arm base=/abs/path/base-database-retry.ts --arm candidate=/abs/path/server/src/database-retry.ts \
 *     --out tmp/perf/f1.json
 *
 * The base file of a commit can be written with
 * `git show <sha>:server/src/database-retry.ts > tmp/perf/base-database-retry.ts`
 * when that version has no relative imports.
 *
 * Options (defaults in brackets): --rates [20,77], --lengths ms [300,1000,3000],
 * --trials [10], --predicates [default,wide], --steady ms [10000], --tail ms
 * [5000], --stall ms [3000] (0 skips the slow-failure case), --query
 * ["select pg_sleep(0.003)"].
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { startFaultProxy } from "./fault-proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const serverRequire = createRequire(path.join(root, "server/package.json"));
const dbRequire = createRequire(path.join(root, "packages/db/package.json"));

async function importFromServer(specifier) {
  return import(pathToFileURL(serverRequire.resolve(specifier)).href);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The first string `code` on the cause chain, or the error name. */
function errorCode(error) {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (typeof current.code === "string") return current.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/**
 * postgres.js 3.4.9 fetches the array types on every new connection and does
 * not handle a failure of that fetch, so a backend that dies while a
 * connection starts raises an unhandled rejection. The server exits on one;
 * the harness counts them instead, per trial, so both arms are measured.
 */
const unhandled = { count: 0, codes: {} };
process.on("unhandledRejection", (reason) => {
  unhandled.count += 1;
  const code = errorCode(reason);
  unhandled.codes[code] = (unhandled.codes[code] ?? 0) + 1;
});

const CHAOS_APPLICATION = "perf-chaos";
const TERMINATE_SQL = `select pg_terminate_backend(pid) from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid()
    and backend_type = 'client backend' and coalesce(application_name, '') <> '${CHAOS_APPLICATION}'`;

async function chaosLoop(control, untilMs) {
  while (performance.now() < untilMs) {
    const started = performance.now();
    await control.unsafe(TERMINATE_SQL).catch(() => undefined);
    await sleep(25 - (performance.now() - started));
  }
}

/**
 * One trial: steady calls, a fault, then a tail. Returns the calls that
 * started during the fault.
 */
async function runTrial({ arm, predicate, rate, faultMs, kind, steadyMs, tailMs, connectionString, control, proxy, createDb, sql, query }) {
  arm.module.resetDatabaseRetryBudget?.();
  const url = kind === "stall"
    ? connectionString.replace(/:(\d+)\//, `:${proxy.port}/`)
    : connectionString;
  const db = createDb(url);
  const options = predicate === "wide" ? { isTransient: arm.module.isTransientDatabaseError } : {};
  const statement = sql.raw(query);
  const calls = [];
  const start = performance.now() + 50;
  const faultStart = start + steadyMs;
  const faultEnd = faultStart + faultMs;
  const total = Math.floor(((steadyMs + faultMs + tailMs) * rate) / 1000);
  const unhandledBefore = unhandled.count;
  const fault = sleep(faultStart - performance.now()).then(() => {
    if (kind === "stall") return proxy.setMode("stall", { stallMs: faultMs });
    return chaosLoop(control, faultEnd);
  });
  for (let index = 0; index < total; index += 1) {
    await sleep(start + (index * 1000) / rate - performance.now());
    const startedAt = performance.now();
    const call = { startedAt, inFault: startedAt >= faultStart && startedAt < faultEnd };
    calls.push(call);
    call.done = arm.module.retryIdempotentDatabaseOperation(() => db.execute(statement), options).then(
      () => { call.ok = true; },
      (error) => { call.ok = false; call.code = errorCode(error); },
    ).finally(() => { call.durationMs = performance.now() - startedAt; });
  }
  await fault;
  await Promise.all(calls.map((call) => call.done));
  await db.$client.end({ timeout: 1 });
  if (kind === "stall") await proxy.setMode("pass");
  return {
    total: calls.length,
    unhandledRejections: unhandled.count - unhandledBefore,
    outsideFailures: calls.filter((call) => !call.inFault && !call.ok).length,
    inFault: calls.filter((call) => call.inFault).map(({ ok, code, durationMs }) => ({ ok, code, durationMs })),
  };
}

function summarize(trials) {
  const inFault = trials.flatMap((trial) => trial.inFault);
  const failed = inFault.filter((call) => !call.ok);
  const codes = {};
  for (const call of failed) codes[call.code] = (codes[call.code] ?? 0) + 1;
  return {
    trials: trials.length,
    started: inFault.length,
    failed: failed.length,
    share: inFault.length === 0 ? 0 : failed.length / inFault.length,
    longestMs: Math.max(0, ...inFault.map((call) => call.durationMs)),
    outsideFailures: trials.reduce((sum, trial) => sum + trial.outsideFailures, 0),
    unhandledRejections: trials.reduce((sum, trial) => sum + trial.unhandledRejections, 0),
    codes,
  };
}

async function f1(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { type: "string", multiple: true },
      rates: { type: "string", default: "20,77" },
      lengths: { type: "string", default: "300,1000,3000" },
      trials: { type: "string", default: "10" },
      predicates: { type: "string", default: "default,wide" },
      steady: { type: "string", default: "10000" },
      tail: { type: "string", default: "5000" },
      stall: { type: "string", default: "3000" },
      query: { type: "string", default: "select pg_sleep(0.003)" },
      out: { type: "string", default: path.join(root, "tmp/perf/f1.json") },
    },
  });
  if (!values.arm || values.arm.length < 1) throw new Error("--arm name=/abs/path/database-retry.ts is required");
  const arms = [];
  for (const spec of values.arm) {
    const [name, file] = spec.split("=");
    arms.push({ name, file: path.resolve(file), module: await import(pathToFileURL(path.resolve(file)).href) });
  }
  const list = (value) => value.split(",").filter(Boolean).map((item) => item.trim());
  const rates = list(values.rates).map(Number);
  const lengths = list(values.lengths).map(Number);
  const predicates = list(values.predicates);
  const trials = Number(values.trials);
  const steadyMs = Number(values.steady);
  const tailMs = Number(values.tail);
  const stallMs = Number(values.stall);

  const { startEmbeddedPostgresTestDatabase, createDb } = await importFromServer("@paperclipai/db");
  const { sql } = await importFromServer("drizzle-orm");
  const postgres = dbRequire("postgres");
  const database = await startEmbeddedPostgresTestDatabase("paperclip-perf-f1-");
  const control = postgres(database.connectionString, {
    max: 1,
    onnotice() {},
    connection: { application_name: CHAOS_APPLICATION },
  });
  const targetPort = Number(new URL(database.connectionString).port);
  const proxy = await startFaultProxy({ targetPort });
  const cases = [];
  for (const rate of rates) {
    for (const predicate of predicates) {
      for (const faultMs of lengths) cases.push({ kind: "terminate", rate, predicate, faultMs });
    }
    if (stallMs > 0) cases.push({ kind: "stall", rate, predicate: "default", faultMs: stallMs });
  }
  const results = [];
  const startedAt = new Date().toISOString();
  try {
    for (const testCase of cases) {
      const byArm = new Map(arms.map((arm) => [arm.name, []]));
      for (let trial = 0; trial < trials; trial += 1) {
        const order = trial % 2 === 0 ? arms : [...arms].reverse();
        for (const arm of order) {
          const result = await runTrial({
            ...testCase, arm, steadyMs, tailMs, control, proxy, createDb, sql,
            connectionString: database.connectionString, query: values.query,
          });
          byArm.get(arm.name).push(result);
        }
      }
      const summary = { ...testCase, arms: Object.fromEntries([...byArm].map(([name, list]) => [name, summarize(list)])) };
      results.push(summary);
      const line = Object.entries(summary.arms)
        .map(([name, s]) => `${name} ${(s.share * 100).toFixed(1)}% (${s.failed}/${s.started}, longest ${Math.round(s.longestMs)} ms, codes ${JSON.stringify(s.codes)})`)
        .join(" | ");
      process.stderr.write(`F1 ${testCase.kind} rate=${testCase.rate} predicate=${testCase.predicate} fault=${testCase.faultMs}ms: ${line}\n`);
    }
  } finally {
    await control.end({ timeout: 1 });
    await proxy.close();
    await database.cleanup();
  }
  const report = {
    kind: "f1",
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    arms: arms.map(({ name, file }) => ({ name, file })),
    settings: { rates, lengths, predicates, trials, steadyMs, tailMs, stallMs, query: values.query },
    results,
  };
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`F1 report: ${values.out}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const commands = { f1 };
if (!commands[command]) {
  process.stderr.write(`usage: faults.mjs <${Object.keys(commands).join("|")}> [options]\n`);
  process.exit(2);
}
await commands[command](rest);
