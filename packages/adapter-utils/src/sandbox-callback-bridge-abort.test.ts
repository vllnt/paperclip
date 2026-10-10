import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
  type SandboxCallbackBridgeQueueClient,
  type SandboxCallbackBridgeReadOptions,
  type SandboxCallbackBridgeWorkerHandle,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

// When the queue worker gives up on a listing or on a request it has not
// started, it aborts the read, so the SSH runner stops the remote command
// instead of letting it run on next to the retry.

const QUEUE_DIR = "/queue";
const REQUESTS_DIR = sandboxCallbackBridgeDirectories(QUEUE_DIR).requestsDir;
const RESPONSES_DIR = sandboxCallbackBridgeDirectories(QUEUE_DIR).responsesDir;
const ITERATION_TIMEOUT_MS = 1_000;

function createClient(hang: { list?: (call: number) => boolean; read?: (call: number) => boolean }) {
  const files = new Map<string, string>();
  const listSignals: Array<AbortSignal | undefined> = [];
  const readSignals: Array<AbortSignal | undefined> = [];
  const never = new Promise<never>(() => {});
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {},
    makeDirs: async () => {},
    listJsonFiles: async (dir, options?: SandboxCallbackBridgeReadOptions) => {
      listSignals.push(options?.signal);
      if (hang.list?.(listSignals.length)) return never;
      return [...files.keys()]
        .filter((file) => path.posix.dirname(file) === dir && file.endsWith(".json"))
        .map((file) => path.posix.basename(file))
        .sort();
    },
    fileSize: async (file) => Buffer.byteLength(files.get(file) ?? ""),
    readTextFile: async (file, _maxBytes, options?: SandboxCallbackBridgeReadOptions) => {
      readSignals.push(options?.signal);
      if (hang.read?.(readSignals.length)) return never;
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
  return { client, listSignals, readSignals, enqueue, response };
}

describe("sandbox callback bridge worker aborts the reads it gives up on", () => {
  let worker: SandboxCallbackBridgeWorkerHandle | null = null;
  let warn: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    const running = worker;
    worker = null;
    if (running) {
      const stopped = running.stop();
      await vi.advanceTimersByTimeAsync(10_000).catch(() => undefined);
      await stopped;
    }
    warn.mockRestore();
    vi.useRealTimers();
  });

  async function start(client: SandboxCallbackBridgeQueueClient, handleRequest = vi.fn(async () => ({ status: 200, body: "{}" }))) {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir: QUEUE_DIR,
      iterationTimeoutMs: ITERATION_TIMEOUT_MS,
      authorizeRequest: () => null,
      handleRequest,
    });
    await vi.advanceTimersByTimeAsync(0);
    return handleRequest;
  }

  it("aborts a queue listing that timed out", async () => {
    const memory = createClient({ list: (call) => call === 1 });
    await start(memory.client);
    const hung = memory.listSignals[0];
    expect(hung?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(ITERATION_TIMEOUT_MS);

    expect(hung?.aborted).toBe(true);
    // The loop keeps polling with a fresh signal.
    await vi.advanceTimersByTimeAsync(500);
    expect(memory.listSignals.length).toBeGreaterThan(1);
    expect(memory.listSignals.at(-1)?.aborted).toBe(false);
  });

  it("aborts the recovery read that timed out, never the request's own read", async () => {
    // The request's own read and the recovery path's read both hang.
    const memory = createClient({ read: (call) => call <= 2 });
    memory.enqueue("slow-read");
    const handleRequest = await start(memory.client);

    await vi.advanceTimersByTimeAsync(ITERATION_TIMEOUT_MS);
    expect(memory.readSignals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ITERATION_TIMEOUT_MS);

    // Stopping the request's own read would drop its guard early; it keeps
    // running to its own command timeout, as before.
    expect(memory.readSignals[0]).toBeUndefined();
    expect(memory.readSignals[1]?.aborted).toBe(true);
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe("command-managed bridge queue client", () => {
  it("passes the read signal to the runner, so the SSH runner can stop the command", async () => {
    const calls: Array<AbortSignal | undefined> = [];
    const runner = {
      execute: vi.fn(async (command: { signal?: AbortSignal; args?: string[] }): Promise<RunProcessResult> => {
        calls.push(command.signal);
        const script = command.args?.[1] ?? "";
        return {
          exitCode: 0, signal: null, timedOut: false, stderr: "", pid: null, startedAt: new Date().toISOString(),
          stdout: script.startsWith("wc -c") ? "2\n" : script.includes("base64") ? `${Buffer.from("{}").toString("base64")}\n2\n` : "",
        };
      }),
    };
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: "/workspace" });
    const controller = new AbortController();

    await client.listJsonFiles("/queue/requests", { signal: controller.signal });
    await client.fileSize!("/queue/requests/a.json", { signal: controller.signal });
    await expect(client.readTextFile("/queue/requests/a.json", 1_000, { signal: controller.signal })).resolves.toBe("{}");

    expect(calls).toEqual([controller.signal, controller.signal, controller.signal]);
    // Writes never get a signal: a stopped write could publish a cut response.
    await client.writeTextFile("/queue/responses/a.json", "{}");
    expect(calls.slice(3)).toEqual(Array(calls.length - 3).fill(undefined));
  });
});
