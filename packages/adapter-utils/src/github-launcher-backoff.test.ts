import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

// The launcher asks the Paperclip server for a credential before every git or gh command. When the server is busy the
// answer is a 409 (the run bridge says so when its own 10 s timeout fires), and when it is slow the launcher's own 10 s
// timeout aborts the request. Both are retried: a busy server must be asked a few times with growing pauses, not every
// second for 30 times while the first request is still running. These tests run the launcher's own brokerPost under
// fake timers, and one real launcher process end to end.

const exec = promisify(execFile);
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAPERCLIP_")));
const BASE_STEPS = [1000, 2000, 4000, 8000];

type Behavior = "409" | "timeout" | "refused" | "ok";
type Brokered = { response: { status: number; ok: boolean }; result: unknown } | null;
type Call = { url: string; startedAt: number; endedAt: number };
type Failure = Error & { diagnostic?: string };
/** What one brokerPost ended with: an answer, or the error it threw. */
type Outcome = { value?: Brokered; error?: Failure };

/** The launcher's brokerPost, unchanged, with a scripted `fetch`, the fake clock, and a chosen jitter. */
type Script = Behavior[] | ((call: number, url: string) => Behavior);
function brokerPostWith(script: Script, jitter: number) {
  const source = githubLauncherSource();
  const start = source.indexOf("async function brokerPost("), end = source.indexOf("const clean = ");
  expect(start, "brokerPost is in the launcher source").toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls: Call[] = [];
  const fetchStub = async (url: string) => {
    const call: Call = { url, startedAt: Date.now(), endedAt: 0 };
    calls.push(call);
    const behavior = typeof script === "function" ? script(calls.length - 1, url) : script[Math.min(calls.length - 1, script.length - 1)]!;
    try {
      if (behavior === "timeout") {
        // The launcher's own limit (AbortSignal.timeout(10000)) fires after 10 s of waiting.
        await new Promise(resolve => globalThis.setTimeout(resolve, 10_000));
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }
      if (behavior === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      const status = behavior === "409" ? 409 : 200;
      return { status, ok: status === 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => (status === 200 ? { status: "available", env: {} } : { error: "busy" }) };
    } finally { call.endedAt = Date.now(); }
  };
  const context = {
    fetch: fetchStub, AbortSignal, URL, Promise, Date, Error, Object, Array, String, Number,
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    Math: Object.assign(Object.create(Math), { random: () => jitter }),
  };
  const brokerPost = runInNewContext(`${source.slice(start, end)}\nbrokerPost`, context) as (env: Record<string, string>, route: string, body: string) => Promise<Brokered>;
  return { brokerPost, calls };
}

const direct = { PAPERCLIP_GITHUB_BROKER_URL: "http://broker.test", PAPERCLIP_GITHUB_BROKER_TOKEN: "capability" };
const bridged = { ...direct, PAPERCLIP_API_BRIDGE_MODE: "1", PAPERCLIP_API_URL: "http://bridge.test" };

/** Runs one brokerPost to its end on the fake clock. */
async function run(script: Script, options: { jitter?: number; env?: Record<string, string> } = {}) {
  const { brokerPost, calls } = brokerPostWith(script, options.jitter ?? 0.999999);
  const begun = Date.now();
  const settled = brokerPost(options.env ?? direct, "/runtime-tools/github/credentials", "{}").then(
    (value): Outcome => ({ value }),
    (error: unknown): Outcome => ({ error: error as Failure }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  const gaps = calls.slice(1).map((call, at) => call.startedAt - calls[at]!.endedAt);
  return { ...outcome, calls, gaps, elapsed: Date.now() - begun };
}

describe("the launcher's retry of a busy or slow Paperclip server", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("asks at most five times when the server keeps answering 409, with growing pauses", async () => {
    const result = await run(["409"]);

    expect(result.calls).toHaveLength(5);
    result.gaps.forEach((gap, at) => {
      expect(gap, `pause ${at + 1}`).toBeGreaterThanOrEqual(BASE_STEPS[at]! * 0.5);
      expect(gap, `pause ${at + 1}`).toBeLessThanOrEqual(BASE_STEPS[at]!);
    });
    for (let at = 1; at < result.gaps.length; at++) expect(result.gaps[at]!).toBeGreaterThan(result.gaps[at - 1]!);
    expect(result.elapsed).toBeLessThanOrEqual(15_000);
  });

  it("spreads the pauses with jitter, between half of a step and the whole step", async () => {
    const low = await run(["409"], { jitter: 0 });
    const high = await run(["409"], { jitter: 0.999999 });

    expect(low.gaps).toEqual([500, 1000, 2000, 4000]);
    expect(high.gaps.map((gap, at) => Math.round(gap / BASE_STEPS[at]! * 100))).toEqual([100, 100, 100, 100]);
  });

  it("ends with an error that names the cause, the number of tries and the time", async () => {
    const result = await run(["409"], { jitter: 0 });

    expect(result.error?.message).toMatch(/credentials unavailable after 5 tries over \d+ s/);
    expect(result.error?.message).toMatch(/busy|409/);
    // The launcher prints this text for the agent, so the error carries it as it is.
    expect(result.error?.diagnostic).toBe(result.error?.message);
    expect(result.value).toBeUndefined();
  });

  it("stops asking as soon as the server answers", async () => {
    const result = await run(["409", "409", "ok"]);

    expect(result.calls).toHaveLength(3);
    expect(result.value?.response.ok).toBe(true);
    expect(result.value?.result).toEqual({ status: "available", env: {} });
  });

  // On main, a request that timed out had the transport budget: three requests, pauses of 0.5 and 1 s, 31.5 s in all. A
  // timed-out request may still be running on the server, so a command that nobody answers must not cost more requests or
  // more waiting than that.
  const TIMEOUT_STEPS = [500, 1000];

  it("retries a request that timed out, twice at most, and a later answer wins", async () => {
    const result = await run(["timeout", "timeout", "ok"]);

    expect(result.calls).toHaveLength(3);
    expect(result.value?.response.ok).toBe(true);
    result.gaps.forEach((gap, at) => {
      expect(gap, `pause ${at + 1}`).toBeGreaterThanOrEqual(TIMEOUT_STEPS[at]! * 0.5);
      expect(gap, `pause ${at + 1}`).toBeLessThanOrEqual(TIMEOUT_STEPS[at]!);
    });
  });

  it("gives up after three timed-out requests, with no more requests and no more waiting than main, and the clear error", async () => {
    const result = await run(["timeout"], { jitter: 0.999999 });

    expect(result.calls).toHaveLength(3);
    // Three requests of 10 s each and two pauses (1.5 s at most): what main spent.
    expect(result.elapsed).toBeLessThanOrEqual(31_500);
    expect(result.error?.message).toMatch(/credentials unavailable after 3 tries over \d+ s/);
    expect(result.error?.message).toMatch(/did not answer/);
  });

  it("mixes 409s and timeouts in one budget of five tries, of which three at most may be timeouts", async () => {
    const result = await run(["409", "timeout", "409", "timeout", "409", "ok"]);

    expect(result.calls).toHaveLength(5);
    expect(result.error?.message).toMatch(/after 5 tries/);
    const timeouts = await run(["409", "timeout", "timeout", "timeout", "ok"]);
    expect(timeouts.calls).toHaveLength(4);
    expect(timeouts.error?.message).toMatch(/after 4 tries/);
  });

  it("keeps the small quick budget for other transport failures (connection refused)", async () => {
    const result = await run(["refused"]);

    expect(result.calls).toHaveLength(3);
    expect(result.gaps).toEqual([500, 1000]);
    expect(result.error).toBeDefined();
  });

});

// A sandbox reaches Paperclip through its run bridge; the broker URL (the server's public address) may not even resolve there.
// A bridge that is slow or busy is still the route that works, so the launcher asks it again. It moves to the other route
// only when the first cannot be reached at all.
describe("which route the launcher asks again", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const BRIDGE = "http://bridge.test/runtime-tools/github/credentials", BROKER = "http://broker.test/runtime-tools/github/credentials";
  /** The bridge says `onBridge` in order (the last one repeats); the broker never answers because its address does not resolve. */
  const bridgeOnly = (onBridge: Behavior[]) => {
    let seen = 0;
    return (_call: number, url: string): Behavior => (url === BRIDGE ? onBridge[Math.min(seen++, onBridge.length - 1)]! : "refused");
  };
  const urlsOf = (calls: Call[]) => calls.map(call => call.url);

  it("asks the bridge again after it timed out once, and gets its answer, with the broker unreachable", async () => {
    const result = await run(bridgeOnly(["timeout", "ok"]), { env: bridged });

    expect(result.value?.response.ok).toBe(true);
    expect(urlsOf(result.calls)).toEqual([BRIDGE, BRIDGE]);
  });

  it("asks the bridge again after a 409, and never the broker", async () => {
    const result = await run(bridgeOnly(["409", "409", "ok"]), { env: bridged });

    expect(result.value?.response.ok).toBe(true);
    expect(urlsOf(result.calls)).toEqual([BRIDGE, BRIDGE, BRIDGE]);
  });

  it("keeps to the bridge for every try when it never answers, and then says why", async () => {
    const result = await run(bridgeOnly(["timeout"]), { env: bridged });

    expect(urlsOf(result.calls)).toEqual([BRIDGE, BRIDGE, BRIDGE]);
    expect(result.error?.message).toMatch(/credentials unavailable after 3 tries over \d+ s/);
  });

  it("moves to the broker at once when the bridge cannot be reached, and the broker answers", async () => {
    const result = await run((_call, url) => (url === BRIDGE ? "refused" : "ok"), { env: bridged });

    expect(result.value?.response.ok).toBe(true);
    expect(urlsOf(result.calls)).toEqual([BRIDGE, BROKER]);
    expect(result.gaps).toEqual([0]);
  });

  it("asks the same route again when it times out after a move to it", async () => {
    let broker = 0;
    const result = await run((_call, url) => (url === BRIDGE ? "refused" : broker++ === 0 ? "timeout" : "ok"), { env: bridged });

    expect(result.value?.response.ok).toBe(true);
    expect(urlsOf(result.calls)).toEqual([BRIDGE, BROKER, BROKER]);
  });

  it("asks the broker again after it timed out, outside a sandbox, and never the API route", async () => {
    let broker = 0;
    const env = { ...direct, PAPERCLIP_API_URL: "http://api.test" };
    const result = await run((_call, url) => (url === BROKER ? (broker++ === 0 ? "timeout" : "ok") : "refused"), { env });

    expect(result.value?.response.ok).toBe(true);
    expect(urlsOf(result.calls)).toEqual([BROKER, BROKER]);
  });
});

describe("a real launcher process", () => {

  /** A launcher whose server answers 409 to every request; `realGh` is the command that then runs without a credential. */
  async function busyServer(realGh: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-busy-"));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), realGh, { mode: 0o700 });
    const state = { requests: 0 };
    const server = createServer((_req, res) => { state.requests++; res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    // Each test cleans up its own server and directory: the two tests run at the same time.
    const cleanup = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
    const command = () => exec(path.join(bin, "gh"), ["pr", "view", "1"], { env: {
      ...hostEnv, ...githubBrokerEnvironment({ GH_TOKEN: "host-token" }, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}`,
    } });
    return { state, command, cleanup };
  }

  it.concurrent("tells the agent why credentials are missing after five busy answers, and still runs the command", async () => {
    const busy = await busyServer('#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));');
    try {
      const result = await busy.command();

      expect(busy.state.requests).toBe(5);
      expect(result.stderr).toMatch(/credentials unavailable after 5 tries over \d+ s/);
      expect(JSON.parse(result.stdout)).toEqual({ token: null });
      expect(result.stderr).not.toMatch(/host-token|run-capability/);
    } finally { await busy.cleanup(); }
  }, 60_000);

  // The end-to-end case of the route tests above, with the real launcher and the real fetch: in a sandbox the bridge is the
  // route that works and the broker address does not answer. The bridge does not answer the first request within the
  // launcher's 10 s limit, and answers the second.
  it.concurrent("keeps asking the sandbox's bridge after it timed out once, while the broker address is unreachable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-bridge-"));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', { mode: 0o700 });
    let bridgeRequests = 0;
    const bridge = createServer((_req, res) => {
      bridgeRequests++;
      if (bridgeRequests === 1) return; // never answered: the launcher's own 10 s limit ends it
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "bridge-token" } }));
    });
    await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
    const bridgePort = (bridge.address() as { port: number }).port;
    // A port that nothing listens on: the broker address of the sandbox does not resolve or accept connections.
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const brokerPort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    try {
      const result = await exec(path.join(bin, "gh"), ["pr", "view", "1"], { env: {
        ...hostEnv, ...githubBrokerEnvironment({ GH_TOKEN: "host-token" }, { url: `http://127.0.0.1:${brokerPort}`, token: "run-capability" }),
        PAPERCLIP_API_BRIDGE_MODE: "1", PAPERCLIP_API_URL: `http://127.0.0.1:${bridgePort}`,
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      } });

      expect(JSON.parse(result.stdout)).toEqual({ token: "bridge-token" });
      expect(bridgeRequests).toBe(2);
      expect(result.stderr).not.toContain("broker_transport_unavailable");
      expect(result.stderr).not.toMatch(/host-token|run-capability/);
    } finally {
      await new Promise<void>(resolve => { bridge.closeAllConnections(); bridge.close(() => resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.concurrent("says it again after the command fails, so the cause is not left to the command's own message", async () => {
    const busy = await busyServer('#!/usr/bin/env node\nprocess.stderr.write("fatal: could not read Username\\n");process.exit(1);');
    try {
      const failure = await busy.command().then(() => null, (error: { stderr: string; code: number }) => error);

      expect(failure?.code).toBe(1);
      const lines = failure!.stderr.trim().split("\n");
      expect(lines.at(-1)).toMatch(/^Paperclip: this command ran without managed GitHub credentials \(credentials unavailable after 5 tries over \d+ s: the Paperclip server is busy \(HTTP 409\)\)\.$/);
      expect(lines.some(line => line.includes("could not read Username"))).toBe(true);
      expect(busy.state.requests).toBe(5);
    } finally { await busy.cleanup(); }
  }, 60_000);
});
