import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  formatSandboxCallbackBridgeSlowPickup,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
  type SandboxCallbackBridgeQueueClient,
  type SandboxCallbackBridgeWorkerHandle,
} from "./sandbox-callback-bridge.js";
import {
  buildSshEnvLabFixtureConfig,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "./ssh.js";

// The host queue worker lists the request queue with one remote command, and
// over SSH every command is a new connection. These tests pin how often an
// idle worker lists, and that a request still gets picked up within the
// stated bound.

const QUEUE_DIR = "/queue";
const REQUESTS_DIR = sandboxCallbackBridgeDirectories(QUEUE_DIR).requestsDir;
const RESPONSES_DIR = sandboxCallbackBridgeDirectories(QUEUE_DIR).responsesDir;

function createMemoryClient(options: { listDelayMs?: number } = {}) {
  const files = new Map<string, string>();
  const listedAt: number[] = [];
  const listed: string[][] = [];
  // Runs right after a listing returns, before the worker sees it.
  let afterList: (() => void) | null = null;
  // Runs when a listing starts. A slow listing returns what was there then.
  let atListStart: (() => void) | null = null;
  let failNextList = false;
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {},
    makeDirs: async () => {},
    listJsonFiles: async (dir) => {
      if (failNextList) {
        failNextList = false;
        throw new Error("listing failed");
      }
      const names = [...files.keys()]
        .filter((file) => path.posix.dirname(file) === dir && file.endsWith(".json"))
        .map((file) => path.posix.basename(file))
        .sort();
      atListStart?.();
      if (options.listDelayMs) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
      listedAt.push(Date.now());
      listed.push(names);
      afterList?.();
      return names;
    },
    fileSize: async (file) => Buffer.byteLength(files.get(file) ?? ""),
    readTextFile: async (file) => {
      const body = files.get(file);
      if (body === undefined) throw new Error(`missing ${file}`);
      return body;
    },
    writeTextFile: async (file, body) => {
      files.set(file, body);
    },
    writeResponseFile: async (file, body) => {
      files.set(file, body);
      return { wrote: true };
    },
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    remove: async (file) => {
      files.delete(file);
    },
  };
  const enqueue = (id: string) => {
    files.set(path.posix.join(REQUESTS_DIR, `${id}.json`), JSON.stringify({
      id, method: "GET", path: "/api/agents/me", query: "", headers: {}, body: "",
      createdAt: new Date().toISOString(),
    }));
  };
  const response = (id: string) => {
    const body = files.get(path.posix.join(RESPONSES_DIR, `${id}.json`));
    return body === undefined ? undefined : JSON.parse(body) as { status: number };
  };
  const onNextList = (fn: () => void) => {
    afterList = () => {
      afterList = null;
      fn();
    };
  };
  const onNextListStart = (fn: () => void) => {
    atListStart = () => {
      atListStart = null;
      fn();
    };
  };
  const failTheNextList = () => {
    failNextList = true;
  };
  return { client, listedAt, listed, enqueue, response, onNextList, onNextListStart, failTheNextList };
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

describe("sandbox callback bridge worker idle polling", () => {
  let worker: SandboxCallbackBridgeWorkerHandle | null = null;

  afterEach(async () => {
    const running = worker;
    worker = null;
    if (running) {
      let done = false;
      const stopped = running.stop().finally(() => {
        done = true;
      });
      // A slow listing in progress holds the stop until it returns.
      while (!done) await vi.advanceTimersByTimeAsync(1_000);
      await stopped;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  type Handler = Parameters<typeof startSandboxCallbackBridgeWorker>[0]["handleRequest"];

  // Jitter off (`random` 0.5) unless a test sets it, so the schedule is exact.
  async function startIdleWorker(
    handleRequest: Handler = vi.fn(async () => ({ status: 200, body: "{}" })),
    options: Partial<Parameters<typeof startSandboxCallbackBridgeWorker>[0]> = {},
    client: { listDelayMs?: number; random?: number } = {},
  ) {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(client.random ?? 0.5);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createMemoryClient({ listDelayMs: client.listDelayMs });
    worker = await startSandboxCallbackBridgeWorker({
      client: memory.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: () => null,
      handleRequest,
      ...options,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Waits until the worker lists again, so a test starts right after a listing.
    const untilNextListing = async () => {
      const listings = memory.listedAt.length;
      while (memory.listedAt.length === listings) await vi.advanceTimersByTimeAsync(1);
    };
    return { ...memory, handleRequest: handleRequest as ReturnType<typeof vi.fn>, untilNextListing };
  }

  it("lists an idle queue at most six times in four seconds, doubling the wait each time", async () => {
    const { listedAt } = await startIdleWorker();
    const start = listedAt[0]!;

    await vi.advanceTimersByTimeAsync(4_000);

    // On a fixed 100 ms poll this was 41 listings, each one SSH login.
    const inWindow = listedAt.filter((time) => time - start <= 4_000);
    expect(inWindow.length).toBeLessThanOrEqual(6);
    expect(gaps(inWindow)).toEqual([100, 200, 400, 800, 1_600]);
  });

  it("caps the idle wait at three seconds", async () => {
    const { listedAt } = await startIdleWorker();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(gaps(listedAt).slice(-10)).toEqual(Array(10).fill(3_000));
    // About 20 listings a minute once idle, against about 600 at 100 ms.
    expect(listedAt.length).toBeLessThanOrEqual(26);
  });

  it("picks up a request queued just after an idle listing within the three-second bound", async () => {
    const { enqueue, response, handleRequest, onNextList, listedAt, untilNextListing } = await startIdleWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    // The worst case: the request lands right after a listing at the longest wait.
    onNextList(() => enqueue("late"));
    await untilNextListing();
    const queuedAt = listedAt.at(-1)!;

    await vi.advanceTimersByTimeAsync(queuedAt + 3_000 - Date.now());

    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(response("late")?.status).toBe(200);
  });

  it("goes back to the fast wait after it handles a request", async () => {
    const { enqueue, listedAt, listed, handleRequest } = await startIdleWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    enqueue("burst-1");
    while (handleRequest.mock.calls.length === 0) await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);

    // The loop lists again at once after the request, then waits 100 ms.
    const served = listed.findIndex((names) => names.includes("burst-1.json"));
    expect(gaps(listedAt.slice(served)).slice(0, 2)).toEqual([0, 100]);

    // A follow-up request soon after the first one waits a short interval.
    enqueue("burst-2");
    await vi.advanceTimersByTimeAsync(200);
    expect(handleRequest).toHaveBeenCalledTimes(2);
  });

  it.each([0, 0.999999])("keeps the worst case with slow listings at what a fixed 100 ms poll gives (random %d)", async (random) => {
    const LIST_MS = 9_900;
    const HANDLER_MS = 8_000;
    const handleRequest = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, HANDLER_MS));
      return { status: 200, body: "{}" };
    });
    const onSlowPickup = vi.fn();
    const { enqueue, response, onNextListStart } = await startIdleWorker(handleRequest, { onSlowPickup }, {
      listDelayMs: LIST_MS, random,
    });
    // Long enough to reach the longest idle wait on an idle-backoff schedule.
    await vi.advanceTimersByTimeAsync(120_000);
    // The worst case: the request lands just after a slow listing started, so
    // that listing misses it.
    let queuedAt = 0;
    onNextListStart(() => {
      enqueue("late");
      queuedAt = Date.now();
    });
    while (!queuedAt) await vi.advanceTimersByTimeAsync(1);
    while (!response("late")) await vi.advanceTimersByTimeAsync(10);

    // A fixed 100 ms poll: the listing in progress, 100 ms, the next listing,
    // then the handler. The idle backoff adds nothing to that.
    console.info(`slow listings, random ${random}: answered ${Date.now() - queuedAt} ms after queueing`);
    expect(Date.now() - queuedAt).toBeLessThanOrEqual(LIST_MS + 100 + LIST_MS + HANDLER_MS + 20);
    expect(onSlowPickup).toHaveBeenCalledTimes(1);
    const pickup = onSlowPickup.mock.calls[0]![0];
    expect(pickup).toMatchObject({ requestId: "late", method: "GET" });
    expect(pickup.pickupMs).toBeGreaterThanOrEqual(LIST_MS + 100 + LIST_MS);
    expect(formatSandboxCallbackBridgeSlowPickup(pickup)).toMatch(
      /^\[paperclip\] Bridge request GET late waited 19\.\d s for the host \(queued .+, listed .+, started .+\)\.\n$/,
    );
  });

  it("does not report a request picked up within the idle bound", async () => {
    const onSlowPickup = vi.fn();
    const { enqueue, response, onNextList, untilNextListing } = await startIdleWorker(undefined, { onSlowPickup });
    await vi.advanceTimersByTimeAsync(30_000);
    onNextList(() => enqueue("on-time"));
    await untilNextListing();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(response("on-time")?.status).toBe(200);
    expect(onSlowPickup).not.toHaveBeenCalled();
  });

  it("keeps the 100 ms wait while a request that outlived its iteration timeout is still in flight", async () => {
    const started: string[] = [];
    const handleRequest = vi.fn(async (request: { id: string }) => {
      started.push(request.id);
      if (request.id === "stuck") return new Promise<never>(() => {});
      return { status: 200, body: "{}" };
    });
    const { enqueue, listedAt, onNextList, untilNextListing } = await startIdleWorker(handleRequest as Handler, {
      iterationTimeoutMs: 1_000, abortedHandlerGraceMs: 120_000,
    });
    enqueue("stuck");
    // The stuck request stays listed (its 504 backstop is far off), so every
    // listing finds only a request in flight.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gaps(listedAt.slice(-6))).toEqual(Array(5).fill(100));

    onNextList(() => enqueue("next"));
    await untilNextListing();
    await vi.advanceTimersByTimeAsync(100);

    expect(started).toEqual(["stuck", "next"]);
  });

  it("picks up a request queued during a long request as soon as that request ends", async () => {
    const times: Record<string, { start: number; end?: number }> = {};
    const handleRequest = vi.fn(async (request: { id: string }) => {
      times[request.id] = { start: Date.now() };
      if (request.id === "long") await new Promise((resolve) => setTimeout(resolve, 8_000));
      times[request.id]!.end = Date.now();
      return { status: 200, body: "{}" };
    });
    const { enqueue } = await startIdleWorker(handleRequest as Handler);
    enqueue("long");
    await vi.advanceTimersByTimeAsync(2_000);
    enqueue("second");
    await vi.advanceTimersByTimeAsync(6_200);

    expect(times.second?.start).toBeDefined();
    expect(times.second!.start - times.long!.end!).toBeLessThanOrEqual(100);
  });

  it.each([
    [0, 0.8],
    [0.999999, 1.2],
  ])("spreads each idle wait by at most 20 percent (random %d)", async (random, factor) => {
    const { listedAt } = await startIdleWorker(undefined, {}, { random });
    await vi.advanceTimersByTimeAsync(60_000);

    const bases = [100, 200, 400, 800, 1_600, 3_000, 3_000, 3_000];
    expect(gaps(listedAt).slice(0, bases.length)).toEqual(bases.map((base) => Math.max(100, Math.round(base * factor))));
  });

  it("starts the idle wait again from 100 ms after a failed listing", async () => {
    const { listedAt, failTheNextList, untilNextListing } = await startIdleWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    failTheNextList();
    // The failed listing records nothing; its retry comes 200 ms later.
    await untilNextListing();
    const recovered = listedAt.length;
    await untilNextListing();

    expect(listedAt[recovered]! - listedAt[recovered - 1]!).toBe(100);
  });

  it("stops without waiting out a long idle wait and still serves a queued request", async () => {
    const { enqueue, response, handleRequest, listedAt, untilNextListing } = await startIdleWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    await untilNextListing();
    // The next listing is 3 s away, more than the 2 s stop drain.
    expect(listedAt.at(-1)! + 3_000 - Date.now()).toBeGreaterThan(2_000);

    enqueue("at-stop");
    let stopped = false;
    const running = worker!;
    worker = null;
    const stop = running.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(stopped).toBe(true);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(response("at-stop")?.status).toBe(200);
    await stop;
    // No idle-wait timer outlives the stop. Stop's own 2 s drain timer ends
    // first; the idle wait would have run 3 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the idle wait under a quarter of a short watchdog, so an idle loop never trips it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { listedAt } = await startIdleWorker(undefined, { watchdogTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(Math.max(...gaps(listedAt))).toBe(250);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("made no successful poll iteration")))
        .toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sandbox callback bridge worker idle polling over SSH", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("opens at most 16 SSH connections while idle for ten seconds", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(`Skipping the idle SSH poll test: ${support.reason}`);
      return;
    }
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-idle-poll-"));
    const statePath = path.join(rootDir, "state.json");
    let worker: SandboxCallbackBridgeWorkerHandle | null = null;
    cleanup = async () => {
      await worker?.stop().catch(() => undefined);
      await stopSshEnvLabFixture(statePath).catch(() => false);
      await rm(rootDir, { recursive: true, force: true });
    };
    let fixture: Awaited<ReturnType<typeof startSshEnvLabFixture>>;
    try {
      fixture = await startSshEnvLabFixture({ statePath });
    } catch (error) {
      // For example as root, where the fixture's sshd refuses the login.
      console.warn(`Skipping the idle SSH poll test: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const config = await buildSshEnvLabFixtureConfig(fixture);
    const runner = createSshCommandManagedRuntimeRunner({
      spec: { ...config, remoteCwd: fixture.workspaceDir },
    });
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: fixture.workspaceDir,
    });
    const logins = async () =>
      (await readFile(fixture.sshdLogPath, "utf8")).split("\n").filter((line) => line.includes("Accepted publickey")).length;
    const before = await logins();

    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir: path.join(fixture.workspaceDir, "queue"),
      handleRequest: async () => ({ status: 200, body: "{}" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await worker.stop();
    worker = null;

    // Startup (queue dirs, host lease), about eight listings, and the two
    // listings of the stop. On a fixed 100 ms poll this was one login per
    // listing round trip, 30 to 60 here.
    const opened = (await logins()) - before;
    console.info(`idle SSH bridge worker: ${opened} SSH connections in 10 s`);
    expect(opened).toBeLessThanOrEqual(16);
  }, 60_000);
});
