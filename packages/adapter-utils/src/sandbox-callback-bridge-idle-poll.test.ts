import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
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

function createMemoryClient() {
  const files = new Map<string, string>();
  const listedAt: number[] = [];
  const listed: string[][] = [];
  // Runs right after a listing returns, before the worker sees it.
  let afterList: (() => void) | null = null;
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {},
    makeDirs: async () => {},
    listJsonFiles: async (dir) => {
      const names = [...files.keys()]
        .filter((file) => path.posix.dirname(file) === dir && file.endsWith(".json"))
        .map((file) => path.posix.basename(file))
        .sort();
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
  return { client, listedAt, listed, enqueue, response, onNextList };
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
      const stopped = running.stop();
      await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      await stopped;
    }
    vi.useRealTimers();
  });

  async function startIdleWorker(
    handleRequest = vi.fn(async () => ({ status: 200, body: "{}" })),
    options: { watchdogTimeoutMs?: number } = {},
  ) {
    vi.useFakeTimers();
    const memory = createMemoryClient();
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
    return { ...memory, handleRequest, untilNextListing };
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
