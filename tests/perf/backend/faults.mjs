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
 *
 *   F4, route level: the server of each arm's checkout behind the proxy,
 *   under the dashboard load, through a flap and a blackout (`f4`, see README).
 *
 *   The per-route statement census (`census`, see README).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { startFaultProxy } from "./fault-proxy.mjs";
import { startServer } from "./lib/server.mjs";

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
 * Before #301, the repository patch of postgres.js 3.4.9 did not handle a
 * failed array-type fetch on a new connection, so a backend that died while a
 * connection started raised an unhandled rejection. The server exits on one;
 * the harness counts them instead, per trial, so a checkout from before #301
 * can still be measured. With #301 the count should be 0.
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

/** F4 fault values (plan section 8), fixed before the first run and the same for every arm. */
const F4_FLAP = { lifeMs: 100, holdMs: 300 };
const F4_CLOUD_STACK = "perf-f4";
const F4_WAKE_SETTLE_MS = 30_000;

function cloudHeaders(token, userId, role) {
  return {
    "x-paperclip-cloud-tenant-token": token,
    "x-paperclip-cloud-user-id": userId,
    "x-paperclip-cloud-user-email": `${userId}@example.com`,
    "x-paperclip-cloud-stack-id": F4_CLOUD_STACK,
    "x-paperclip-cloud-stack-role": role,
  };
}

// Longer than any wait a fault causes, so the longest request is measured, not cut off.
async function request(base, method, route, { headers = {}, body, timeoutMs = 90_000 } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: response.status, json };
}

async function must(pending, what) {
  const response = await pending;
  if (response.status >= 300) throw new Error(`${what}: HTTP ${response.status} ${JSON.stringify(response.json).slice(0, 300)}`);
  return response.json;
}

/**
 * The `auth` server: authenticated mode with the cloud-tenant trust token, so
 * every request runs the actor lookup. Returns the request senders.
 */
async function seedAuth(url, token) {
  const owner = cloudHeaders(token, "perf-owner", "owner");
  const me = await must(request(url, "GET", "/api/cli-auth/me", { headers: owner }), "owner lookup");
  const companyId = me.companyIds?.[0];
  if (!companyId) throw new Error(`no company for the cloud stack: ${JSON.stringify(me).slice(0, 300)}`);
  for (let index = 0; index < 20; index += 1) {
    await must(request(url, "POST", `/api/companies/${companyId}/issues`, { headers: owner, body: { title: `[perf] issue ${index}`, status: "todo" } }), "seed issue");
  }
  const dashboard = cloudHeaders(token, "perf-dashboard", "member");
  const reader = cloudHeaders(token, "perf-reader", "member");
  return {
    dashboard: () => request(url, "GET", `/api/companies/${companyId}/dashboard`, { headers: dashboard }),
    auth: () => request(url, "GET", "/api/auth/get-session", { headers: reader }),
  };
}

/**
 * The `wake` server: local_trusted, so no actor lookup runs. Every assignment
 * assigns an unassigned `todo` issue, so each 2xx answer must queue one wake.
 */
async function seedWake(url, assignments) {
  const company = await must(request(url, "POST", "/api/companies", { body: { name: "Perf F4" } }), "seed company");
  const agent = await must(request(url, "POST", `/api/companies/${company.id}/agents`, {
    body: {
      name: "Perf F4 agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }), "seed agent");
  const issues = [];
  for (let index = 0; index < assignments; index += 1) {
    issues.push(await must(request(url, "POST", `/api/companies/${company.id}/issues`, { body: { title: `[perf] wake ${index}`, status: "todo" } }), "seed issue"));
  }
  let next = 0;
  return {
    dashboard: () => request(url, "GET", `/api/companies/${company.id}/dashboard`),
    assign: async () => {
      const issue = issues[next];
      next += 1;
      if (!issue) throw new Error("ran out of seeded issues");
      const response = await request(url, "PATCH", `/api/issues/${issue.id}`, { body: { assigneeAgentId: agent.id } });
      return { ...response, wakeKeyPrefix: `issue-assignment:${issue.id}:${agent.id}:` };
    },
  };
}

/**
 * The statements one healthy request of each route sends, counted at the
 * proxy with nothing else running, minus the server's idle background rate.
 * The background is bursty, so the idle rate is taken over 10 s and each
 * route needs enough samples for its window to average the bursts out.
 * `settleMs` waits for work that a route does after its response (the wake).
 */
async function statementCensus(proxy, senders, samples, settleMs = {}) {
  // The first request of a user runs the full actor sync; keep it out of the count.
  for (const send of Object.values(senders)) await send();
  proxy.resetStats();
  const idleStarted = performance.now();
  await sleep(10_000);
  const idlePerMs = proxy.stats().statements / (performance.now() - idleStarted);
  const routes = {};
  for (const [name, send] of Object.entries(senders)) {
    proxy.resetStats();
    const started = performance.now();
    for (let index = 0; index < samples; index += 1) {
      const response = await send();
      if (response.status >= 300) throw new Error(`census ${name}: HTTP ${response.status}`);
    }
    await sleep(settleMs[name] ?? 0);
    const statements = proxy.stats().statements - idlePerMs * (performance.now() - started);
    routes[name] = Math.max(0, statements / samples);
  }
  return { idleStatementsPerSecond: idlePerMs * 1000, statementsPerRequest: routes };
}

/** Sends `send()` at a fixed rate from `startAt` to `endAt` (open loop) and records each request. */
async function openLoop({ name, rate, startAt, endAt, send, records }) {
  if (!(rate > 0)) return;
  const pending = [];
  for (let index = 0; ; index += 1) {
    const at = startAt + (index * 1000) / rate;
    if (at >= endAt) break;
    await sleep(at - performance.now());
    const record = { route: name, startedAt: performance.now() };
    records.push(record);
    pending.push(send().then(
      (response) => {
        record.status = response.status;
        record.ok = response.status < 400;
        record.wakeKeyPrefix = response.wakeKeyPrefix;
      },
      (error) => {
        record.status = 0;
        record.ok = false;
        record.code = errorCode(error);
      },
    ).finally(() => { record.durationMs = performance.now() - record.startedAt; }));
  }
  await Promise.all(pending);
}

/** Switches the proxy at each phase boundary and reads its counters at each phase end. */
async function drivePhases(proxy, phases, startAt) {
  const results = [];
  let at = startAt;
  for (const phase of phases) {
    await sleep(at - performance.now());
    proxy.resetStats();
    const startEpoch = Date.now();
    await proxy.setMode(phase.mode, phase.mode === "flap" ? F4_FLAP : {});
    const startPerf = at;
    at += phase.ms;
    await sleep(at - performance.now());
    results.push({ name: phase.name, startPerf, endPerf: at, startEpoch, endEpoch: Date.now(), proxy: proxy.stats() });
  }
  await proxy.setMode("pass");
  return results;
}

function phaseReport(phase, records, census, budgetWarnings, wakeKeys) {
  const seconds = (phase.endPerf - phase.startPerf) / 1000;
  const routes = {};
  for (const record of records) {
    if (record.startedAt < phase.startPerf || record.startedAt >= phase.endPerf) continue;
    const route = (routes[record.route] ??= { requests: 0, failed: 0, longestMs: 0, statuses: {} });
    route.requests += 1;
    if (!record.ok) route.failed += 1;
    route.longestMs = Math.max(route.longestMs, Math.round(record.durationMs));
    const status = record.code ?? record.status;
    route.statuses[status] = (route.statuses[status] ?? 0) + 1;
    if (record.route === "assign" && record.ok) {
      route.answered2xx = (route.answered2xx ?? 0) + 1;
      if (wakeKeys && [...wakeKeys].some((key) => key.startsWith(record.wakeKeyPrefix))) route.woken = (route.woken ?? 0) + 1;
    }
  }
  if (routes.assign) routes.assign.wakeShare = routes.assign.answered2xx ? (routes.assign.woken ?? 0) / routes.assign.answered2xx : null;
  // The bound of the budget itself (plan section 8, F4): at most 2 × the calls
  // plus 10 a second attempts, converted to statements with the census. The
  // census counts a request, which is an upper bound of one attempt. A
  // request that a fault holds sends its statements in a later phase, so the
  // calls of a phase are the requests active in it, not only those started in it.
  const perRequest = census.statementsPerRequest;
  const largest = Math.max(0, ...Object.values(perRequest));
  const active = records.filter((record) => record.startedAt < phase.endPerf && record.startedAt + record.durationMs > phase.startPerf);
  const statementBound = active.reduce((sum, record) => sum + 2 * (perRequest[record.route] ?? largest), 0)
    + 10 * seconds * largest + census.idleStatementsPerSecond * seconds;
  const refusedRetries = budgetWarnings
    .filter((warning) => warning.time >= phase.startEpoch && warning.time < phase.endEpoch)
    .reduce((sum, warning) => sum + (warning.refusedRetries ?? 0), 0);
  return {
    name: phase.name,
    seconds,
    statements: phase.proxy.statements,
    statementsPerSecond: phase.proxy.statements / seconds,
    busiestStatementSecond: phase.proxy.busiestStatementSecond,
    acceptedPerSecond: phase.proxy.accepted / seconds,
    busiestAcceptSecond: phase.proxy.busiestAcceptSecond,
    peakOpen: phase.proxy.peakOpen,
    peakInFlight: phase.proxy.peakInFlight,
    resets: phase.proxy.resets,
    medianResetLifetimeMs: phase.proxy.medianResetLifetimeMs,
    statementBound: Math.round(statementBound),
    withinBound: phase.proxy.statements <= statementBound,
    refusedRetries,
    routes,
  };
}

/** One server run of one arm and one configuration on a new embedded database. */
async function runF4({ arm, config, phases, rates, censusSamples, importers }) {
  const { startEmbeddedPostgresTestDatabase, postgres } = importers;
  const database = await startEmbeddedPostgresTestDatabase("paperclip-perf-f4-");
  const proxy = await startFaultProxy({ targetPort: Number(new URL(database.connectionString).port) });
  const control = postgres(database.connectionString, { max: 1, onnotice() {} });
  const token = config === "auth" ? randomBytes(24).toString("hex") : undefined;
  const totalMs = phases.reduce((sum, phase) => sum + phase.ms, 0);
  let server = null;
  try {
    server = await startServer({
      checkout: arm.checkout,
      databaseUrl: database.connectionString.replace(/:(\d+)\//, `:${proxy.port}/`),
      // Boot-time migration checks go straight to the database, off the proxy counters.
      migrationUrl: database.connectionString,
      mode: config === "auth" ? "authenticated" : "local_trusted",
      cloudTenantToken: token,
    });
    const assignments = Math.ceil((rates.assign * totalMs) / 1000) + censusSamples + 10;
    const senders = config === "auth" ? await seedAuth(server.url, token) : await seedWake(server.url, assignments);
    // The wake is delivered after the assignment's response.
    const census = await statementCensus(proxy, senders, censusSamples, { assign: 1_000 });
    const records = [];
    const startAt = performance.now() + 200;
    const endAt = startAt + totalMs;
    const [phaseResults] = await Promise.all([
      drivePhases(proxy, phases, startAt),
      ...Object.entries(senders).map(([name, send]) => openLoop({ name, rate: rates[name], startAt, endAt, send, records })),
    ]);
    let wakeKeys = null;
    if (config === "wake") {
      await sleep(F4_WAKE_SETTLE_MS);
      const rows = await control.unsafe("select idempotency_key from agent_wakeup_requests where idempotency_key like 'issue-assignment:%'");
      wakeKeys = new Set(rows.map((row) => row.idempotency_key));
    }
    return {
      arm: arm.name,
      config,
      census,
      serverExit: server.exited(),
      serverErrorLines: server.log.errors,
      phases: phaseResults.map((phase) => phaseReport(phase, records, census, server.log.budgetWarnings, wakeKeys)),
    };
  } finally {
    await server?.stop();
    await control.end({ timeout: 1 });
    await proxy.close();
    await database.cleanup();
  }
}

async function f4(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { type: "string", multiple: true },
      configs: { type: "string", default: "auth,wake" },
      pairs: { type: "string", default: "5" },
      steady: { type: "string", default: "20000" },
      flap: { type: "string", default: "10000" },
      recover: { type: "string", default: "20000" },
      blackout: { type: "string", default: "10000" },
      tail: { type: "string", default: "10000" },
      "dashboard-rate": { type: "string", default: "19" },
      "auth-rate": { type: "string", default: "20" },
      "assign-rate": { type: "string", default: "5" },
      census: { type: "string", default: "20" },
      out: { type: "string", default: path.join(root, "tmp/perf/f4.json") },
    },
  });
  if (!values.arm || values.arm.length < 1) throw new Error("--arm name=/abs/path/to/checkout is required");
  const arms = values.arm.map((spec) => {
    const split = spec.indexOf("=");
    return { name: spec.slice(0, split), checkout: path.resolve(spec.slice(split + 1)) };
  });
  const phases = [
    { name: "steady", mode: "pass", ms: Number(values.steady) },
    { name: "flap", mode: "flap", ms: Number(values.flap) },
    { name: "recover", mode: "pass", ms: Number(values.recover) },
    { name: "blackout", mode: "refuse", ms: Number(values.blackout) },
    { name: "tail", mode: "pass", ms: Number(values.tail) },
  ].filter((phase) => phase.ms > 0);
  const rates = { dashboard: Number(values["dashboard-rate"]), auth: Number(values["auth-rate"]), assign: Number(values["assign-rate"]) };
  const configs = values.configs.split(",").map((item) => item.trim()).filter(Boolean);
  const pairs = Number(values.pairs);
  const { startEmbeddedPostgresTestDatabase } = await importFromServer("@paperclipai/db");
  const importers = { startEmbeddedPostgresTestDatabase, postgres: dbRequire("postgres") };
  const runs = [];
  const startedAt = new Date().toISOString();
  for (let pair = 0; pair < pairs; pair += 1) {
    const order = pair % 2 === 0 ? arms : [...arms].reverse();
    for (const config of configs) {
      for (const arm of order) {
        const run = { pair, ...(await runF4({ arm, config, phases, rates, censusSamples: Number(values.census), importers })) };
        runs.push(run);
        for (const phase of run.phases) {
          const routes = Object.entries(phase.routes)
            .map(([name, route]) => `${name} ${route.failed}/${route.requests} failed, longest ${route.longestMs} ms${route.wakeShare == null ? "" : `, woken ${(route.wakeShare * 100).toFixed(1)}%`}`)
            .join("; ");
          process.stderr.write(`F4 pair=${pair} ${config} ${arm.name} ${phase.name}: ${phase.statements} statements (bound ${phase.statementBound}), peak open ${phase.peakOpen}, peak in flight ${phase.peakInFlight}, refused ${phase.refusedRetries}; ${routes}\n`);
        }
        if (run.serverExit) process.stderr.write(`F4 pair=${pair} ${config} ${arm.name}: the server exited during the run ${JSON.stringify(run.serverExit)}\n`);
      }
    }
  }
  const report = {
    kind: "f4",
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    arms,
    settings: { configs, pairs, phases, rates, flap: F4_FLAP, wakeSettleMs: F4_WAKE_SETTLE_MS, censusSamples: Number(values.census) },
    runs,
  };
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`F4 report: ${values.out}\n`);
}

/** Routes of the census (the read routes of the production B0, plan section 4.7). {c} = company id, {i} = issue id. */
const CENSUS_ROUTES = [
  ["dashboard", "/api/companies/{c}/dashboard"],
  ["sidebar-badges", "/api/companies/{c}/sidebar-badges"],
  ["live-runs", "/api/companies/{c}/live-runs"],
  ["activity", "/api/companies/{c}/activity"],
  ["heartbeat-runs", "/api/companies/{c}/heartbeat-runs?limit=200"],
  ["agents", "/api/companies/{c}/agents"],
  ["skills", "/api/companies/{c}/skills"],
  ["attention", "/api/companies/{c}/attention"],
  ["issues-default", "/api/companies/{c}/issues"],
  ["issues-compact", "/api/companies/{c}/issues?view=compact&limit=100"],
  ["issue-by-id", "/api/issues/{i}"],
  ["issue-comments", "/api/issues/{i}/comments"],
];

/** A company with `size` issues, two comments each, and one agent per ten issues that the issues are assigned to. */
async function seedCensus(url, size) {
  const company = await must(request(url, "POST", "/api/companies", { body: { name: `Perf census ${size}` } }), "seed company");
  const agents = [];
  for (let index = 0; index < Math.max(1, Math.round(size / 10)); index += 1) {
    agents.push(await must(request(url, "POST", `/api/companies/${company.id}/agents`, {
      body: {
        name: `Perf census agent ${index}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }), "seed agent"));
  }
  let issue = null;
  for (let index = 0; index < size; index += 1) {
    issue = await must(request(url, "POST", `/api/companies/${company.id}/issues`, {
      body: { title: `[perf] census ${index}`, status: "todo", assigneeAgentId: agents[index % agents.length].id },
    }), "seed issue");
    for (let comment = 0; comment < 2; comment += 1) {
      await must(request(url, "POST", `/api/issues/${issue.id}/comments`, { body: { body: `[perf] comment ${comment}` } }), "seed comment");
    }
  }
  return Object.fromEntries(CENSUS_ROUTES.map(([name, route]) => [
    name,
    () => request(url, "GET", route.replace("{c}", company.id).replace("{i}", issue.id)),
  ]));
}

/**
 * The per-route statement census (plan step 2b, section 14.5): the statements
 * one healthy request of each route sends, at two or more data sizes, on a
 * local_trusted server behind the fault proxy in pass mode. A route whose
 * count grows with the number of issues reads as N+1 shaped.
 */
async function census(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      checkout: { type: "string", default: root },
      sizes: { type: "string", default: "10,100" },
      samples: { type: "string", default: "30" },
      out: { type: "string", default: path.join(root, "tmp/perf/census.json") },
    },
  });
  const sizes = values.sizes.split(",").map(Number).filter((size) => size > 0).sort((a, b) => a - b);
  const { startEmbeddedPostgresTestDatabase } = await importFromServer("@paperclipai/db");
  const bySize = {};
  for (const size of sizes) {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-perf-census-");
    const proxy = await startFaultProxy({ targetPort: Number(new URL(database.connectionString).port) });
    let server = null;
    try {
      server = await startServer({
        checkout: path.resolve(values.checkout),
        databaseUrl: database.connectionString.replace(/:(\d+)\//, `:${proxy.port}/`),
        migrationUrl: database.connectionString,
        mode: "local_trusted",
      });
      bySize[size] = await statementCensus(proxy, await seedCensus(server.url, size), Number(values.samples));
      process.stderr.write(`census size=${size}: ${JSON.stringify(Object.fromEntries(Object.entries(bySize[size].statementsPerRequest).map(([name, count]) => [name, Math.round(count * 10) / 10])))}\n`);
    } finally {
      await server?.stop();
      await proxy.close();
      await database.cleanup();
    }
  }
  const [small, large] = [sizes[0], sizes.at(-1)];
  const routes = Object.fromEntries(CENSUS_ROUTES.map(([name]) => {
    const counts = Object.fromEntries(sizes.map((size) => [size, bySize[size].statementsPerRequest[name]]));
    // Extra statements per extra issue between the smallest and the largest size.
    const perIssue = large > small ? (counts[large] - counts[small]) / (large - small) : null;
    return [name, { statementsPerRequest: counts, perIssue, nPlusOneShaped: perIssue !== null && perIssue >= 0.5 }];
  }));
  const report = {
    kind: "census",
    finishedAt: new Date().toISOString(),
    node: process.version,
    checkout: path.resolve(values.checkout),
    settings: { sizes, samples: Number(values.samples), commentsPerIssue: 2, issuesPerAgent: 10 },
    idleStatementsPerSecond: Object.fromEntries(sizes.map((size) => [size, bySize[size].idleStatementsPerSecond])),
    routes,
  };
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, route] of Object.entries(routes)) {
    process.stderr.write(`census ${name}: ${sizes.map((size) => `${size}: ${route.statementsPerRequest[size]?.toFixed(1)}`).join(", ")}; per issue ${route.perIssue?.toFixed(2)}${route.nPlusOneShaped ? " (N+1 shaped)" : ""}\n`);
  }
  process.stderr.write(`census report: ${values.out}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const commands = { f1, f4, census };
if (!commands[command]) {
  process.stderr.write(`usage: faults.mjs <${Object.keys(commands).join("|")}> [options]\n`);
  process.exit(2);
}
await commands[command](rest);
