// node --test tests/perf/backend/harness.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { startFaultProxy } from "./fault-proxy.mjs";
import { analyzeRoute, dashboardRows, listRows } from "./lib/census.mjs";
import { startServer } from "./lib/server.mjs";
import { decideRow, medianIntervalRank, pairsNeeded } from "./lib/stats.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An untyped startup message (protocol 3.0) and a typed message. */
const startup = () => {
  const body = Buffer.from("user\0perf\0\0", "latin1");
  const header = Buffer.alloc(8);
  header.writeInt32BE(body.length + 8, 0);
  header.writeInt32BE(196608, 4);
  return Buffer.concat([header, body]);
};
const typed = (type, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
};
const readyForQuery = () => typed("Z", Buffer.from("I", "latin1"));

/** A stand-in database: ReadyForQuery after the startup and after each Query or Sync. */
function fakeDatabase() {
  const server = net.createServer((socket) => {
    let started = false;
    socket.on("data", (chunk) => {
      if (!started) {
        started = true;
        socket.write(readyForQuery());
        return;
      }
      for (let offset = 0; offset < chunk.length;) {
        const type = String.fromCharCode(chunk[offset]);
        offset += chunk.readInt32BE(offset + 1) + 1;
        if (type === "Q" || type === "S") socket.write(readyForQuery());
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A client of the proxy that can wait for the next `count` bytes or for the end of the socket. */
function connect(port) {
  const socket = net.connect({ host: "127.0.0.1", port });
  const state = { received: Buffer.alloc(0), ended: null };
  socket.on("data", (chunk) => { state.received = Buffer.concat([state.received, chunk]); });
  const ended = new Promise((resolve) => {
    socket.on("error", (error) => { state.ended = error.code; resolve(error.code); });
    socket.on("close", () => { state.ended ??= "closed"; resolve(state.ended); });
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, state, ended, opened };
}

async function until(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(5);
  }
}

describe("stats", () => {
  it("uses ranks 2 and 9 of 10 pairs for the 95% interval of the median", () => {
    assert.equal(medianIntervalRank(10), 2);
    assert.equal(medianIntervalRank(5), 0);
  });

  it("passes, fails or stays inconclusive against the threshold", () => {
    const pairs = (center) => Array.from({ length: 10 }, (_, index) => center + index - 4.5);
    assert.equal(decideRow(pairs(-10), 5).verdict, "pass");
    assert.equal(decideRow(pairs(20), 5).verdict, "fail");
    assert.equal(decideRow(pairs(5), 5).verdict, "inconclusive");
    assert.equal(decideRow([1, 2], 5).verdict, "inconclusive");
  });

  it("decides nothing on fewer than 10 pairs, even where an interval exists", () => {
    // 6 pairs is the least that has a 95% interval; the plan decides a row on 10 or more.
    const eight = [-10, -9, -8, -7, -6, -5, -4, -3];
    assert.equal(medianIntervalRank(8) > 0, true);
    assert.equal(decideRow(eight, 5).verdict, "inconclusive");
    assert.equal(decideRow([...eight, -2], 5).verdict, "inconclusive");
    assert.equal(decideRow([...eight, -2, -1], 5).verdict, "pass");
  });

  it("asks for at least 10 pairs", () => {
    assert.equal(pairsNeeded([0, 0, 0], 5).needed, 10);
    assert.ok(pairsNeeded([-10, 10, -10, 10], 5).needed > 10);
  });
});

describe("census", () => {
  const sizes = [10, 100];
  const route = (statements, rows, agents = { 10: 1, 100: 10 }) => analyzeRoute({ sizes, statements, rows, agents });

  it("counts the rows of a list, of a wrapper and of the dashboard counters", () => {
    assert.equal(listRows([1, 2, 3]), 3);
    assert.equal(listRows({ items: [1, 2], nextCursor: null, totalCount: 9 }), 2);
    assert.equal(listRows({ count: 4 }), 0);
    assert.equal(listRows(null), 0);
    const dashboard = { agents: { active: 2, running: 1, paused: 0, error: 0 }, tasks: { open: 7, inProgress: 3, blocked: 1, done: 5 }, runActivity: [] };
    assert.equal(dashboardRows(dashboard), 3 + 7 + 5);
    assert.equal(dashboardRows(undefined), 0);
  });

  it("reads a flat count over growing rows as not N+1 shaped", () => {
    const result = route({ 10: 12, 100: 12.2 }, { 10: 10, 100: 100 });
    assert.equal(result.status, "measured");
    assert.equal(result.nPlusOneShaped, false);
  });

  it("flags a count that grows by a statement per returned row", () => {
    const result = route({ 10: 12, 100: 102 }, { 10: 10, 100: 100 });
    assert.equal(result.nPlusOneShaped, true);
    assert.equal(result.perReturnedRow, 1);
  });

  it("flags a statement per agent although the issues outnumber the agents ten to one", () => {
    // 9 more agents, 9 more statements: 0.1 a row, 1 an agent.
    const result = route({ 10: 12, 100: 21 }, { 10: 10, 100: 100 });
    assert.equal(result.perReturnedRow, 0.1);
    assert.equal(result.perAgent, 1);
    assert.equal(result.nPlusOneShaped, true);
  });

  it("marks a route unmeasured, not clean, when its response does not grow", () => {
    const result = route({ 10: 3, 100: 3 }, { 10: 0, 100: 0 });
    assert.equal(result.status, "unmeasured");
    assert.equal(result.nPlusOneShaped, null);
    assert.equal(route({ 10: 3, 100: 3 }, { 10: 50, 100: 50 }).status, "unmeasured");
  });

  it("marks every route unmeasured with a single size", () => {
    const result = analyzeRoute({ sizes: [10], statements: { 10: 5 }, rows: { 10: 10 }, agents: { 10: 1 } });
    assert.equal(result.status, "unmeasured");
    assert.equal(result.nPlusOneShaped, null);
  });
});

describe("server launcher", () => {
  let tmp;
  let previousTmpdir;
  before(() => {
    // The launcher makes its home under os.tmpdir(): use a private one to see what it leaves.
    previousTmpdir = process.env.TMPDIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perf-launcher-test-"));
    process.env.TMPDIR = tmp;
  });
  after(() => {
    process.env.TMPDIR = previousTmpdir;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A stand-in checkout whose `server/src/index.ts` is `source`. */
  function fakeCheckout(source) {
    const dir = fs.mkdtempSync(path.join(tmp, "checkout-"));
    fs.mkdirSync(path.join(dir, "server/node_modules/tsx/dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server/node_modules/tsx/dist/loader.mjs"), "");
    fs.mkdirSync(path.join(dir, "server/src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server/src/index.ts"), source);
    return dir;
  }
  const homes = () => fs.readdirSync(tmp).filter((name) => name.startsWith("paperclip-perf-f4-"));
  const options = (checkout, extra = {}) => ({ checkout, databaseUrl: "postgres://unused", migrationUrl: "postgres://unused", mode: "local_trusted", ...extra });

  it("removes its home when the server exits during the start", async () => {
    const checkout = fakeCheckout("process.exit(3);");
    await assert.rejects(startServer(options(checkout)), /server exited during start/);
    assert.deepEqual(homes(), []);
  });

  it("stops the server and removes its home when it is not ready in time", async () => {
    const checkout = fakeCheckout("setInterval(() => {}, 1000);");
    await assert.rejects(startServer(options(checkout, { readyTimeoutMs: 1_500 })), /not ready in 1500 ms/);
    assert.deepEqual(homes(), []);
  });

  it("keeps the lines of stdout and stderr apart when their chunks interleave", async () => {
    const checkout = fakeCheckout(`
      const http = require("node:http");
      process.stdout.write('{"level":40,"time":1,"msg":"database retry budget re');
      process.stderr.write('{"level":50,"time":2,"msg":"boom"}\\n');
      setTimeout(() => process.stdout.write('fused retries","refusedRetries":3}\\n'), 100);
      http.createServer((req, res) => res.end(JSON.stringify({ status: "ok" }))).listen(Number(process.env.PORT), "127.0.0.1");
    `);
    const server = await startServer(options(checkout));
    try {
      await until(() => server.log.budgetWarnings.length === 1, 5_000);
      assert.deepEqual(server.log.budgetWarnings, [{ time: 1, refusedRetries: 3 }]);
      assert.equal(server.log.errors, 1);
    } finally {
      await server.stop();
    }
    assert.deepEqual(homes(), []);
  });
});

describe("fault proxy", () => {
  let database;
  let proxy;
  before(async () => {
    database = await fakeDatabase();
    proxy = await startFaultProxy({ targetPort: database.address().port });
  });
  after(async () => {
    await proxy.close();
    await new Promise((resolve) => database.close(resolve));
  });

  it("forwards and counts statements, statements in flight and connections", async () => {
    await proxy.setMode("pass");
    proxy.resetStats();
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    await until(() => client.state.received.length >= 6);
    client.socket.write(Buffer.concat([typed("Q", Buffer.from("select 1\0", "latin1")), typed("Q", Buffer.from("select 2\0", "latin1"))]));
    client.socket.write(Buffer.concat([typed("E", Buffer.from("\0\0\0\0\0", "latin1")), typed("S")]));
    await until(() => client.state.received.length >= 6 * 4);
    const stats = proxy.stats();
    assert.equal(stats.statements, 3);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.peakOpen, 1);
    assert.ok(stats.peakInFlight >= 1 && stats.peakInFlight <= 3);
    await until(() => proxy.stats().inFlight === 0);
    client.socket.destroy();
    await client.ended;
  });

  it("flap: holds a new connection, gives it its life after the hold, then resets it", async () => {
    await proxy.setMode("flap", { lifeMs: 80, holdMs: 60 });
    proxy.resetStats();
    const started = Date.now();
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    // The life starts when the hold ends, so the connection reaches the database.
    await until(() => client.state.received.length >= 6);
    assert.ok(Date.now() - started >= 55, "answered before the hold ended");
    assert.equal(await client.ended, "ECONNRESET");
    const stats = proxy.stats();
    assert.equal(stats.resets, 1);
    assert.ok(stats.medianResetLifetimeMs >= 130, `lifetime ${stats.medianResetLifetimeMs} ms is shorter than hold + life`);
    await proxy.setMode("pass");
  });

  it("flap: counts only connections accepted since resetStats in the failed-attempt time", async () => {
    await proxy.setMode("pass");
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    await until(() => client.state.received.length >= 6);
    await sleep(150);
    proxy.resetStats();
    await proxy.setMode("flap", { lifeMs: 20, holdMs: 10 });
    assert.equal(await client.ended, "ECONNRESET");
    const stats = proxy.stats();
    assert.equal(stats.resets, 1);
    assert.equal(stats.medianResetLifetimeMs, null);
    await proxy.setMode("pass");
  });

  it("refuse: refuses new connections and accepts them again in pass mode", async () => {
    await proxy.setMode("refuse");
    const refused = connect(proxy.port);
    await assert.rejects(refused.opened, { code: "ECONNREFUSED" });
    await proxy.setMode("pass");
    const client = connect(proxy.port);
    await client.opened;
    client.socket.destroy();
    await client.ended;
  });

  it("refuse: resets the open connections and does not wait for them to close on their own", async () => {
    await proxy.setMode("pass");
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    await until(() => client.state.received.length >= 6);
    // A database pool keeps its connections open, so the switch must not wait for them.
    const switched = await Promise.race([proxy.setMode("refuse").then(() => "switched"), sleep(1_000).then(() => "hung")]);
    assert.equal(switched, "switched");
    assert.equal(await client.ended, "ECONNRESET");
    await proxy.setMode("pass");
  });

  it("stall: forwards nothing for the stall, then resets the connection", async () => {
    await proxy.setMode("pass");
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    await until(() => client.state.received.length >= 6);
    await proxy.setMode("stall", { stallMs: 80 });
    client.socket.write(typed("Q", Buffer.from("select 1\0", "latin1")));
    await sleep(50);
    assert.equal(client.state.received.length, 6, "a stalled connection got an answer");
    assert.equal(await client.ended, "ECONNRESET");
  });
});
