// node --test tests/perf/backend/harness.test.mjs
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";

import { startFaultProxy } from "./fault-proxy.mjs";
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

  it("asks for at least 10 pairs", () => {
    assert.equal(pairsNeeded([0, 0, 0], 5).needed, 10);
    assert.ok(pairsNeeded([-10, 10, -10, 10], 5).needed > 10);
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

  it("flap: holds a new connection, then resets it after its life", async () => {
    await proxy.setMode("flap", { lifeMs: 80, holdMs: 30 });
    proxy.resetStats();
    const started = Date.now();
    const client = connect(proxy.port);
    await client.opened;
    client.socket.write(startup());
    await until(() => client.state.received.length >= 6);
    assert.ok(Date.now() - started >= 25, "answered before the hold ended");
    assert.equal(await client.ended, "ECONNRESET");
    const stats = proxy.stats();
    assert.equal(stats.resets, 1);
    assert.ok(stats.medianResetLifetimeMs >= 75);
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
