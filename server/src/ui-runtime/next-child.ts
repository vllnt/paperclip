import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import path from "node:path";

/**
 * `starting`: no child has reported ready yet, or one that had been ready is
 * being restarted. `ready`: the child accepts connections on `port()`.
 * `failed`: the last attempt crashed or missed the readiness deadline before it
 * reported ready; the supervisor keeps retrying in the background.
 */
export type NextChildState = "starting" | "ready" | "failed";

type LogFn = (fields: Record<string, unknown>, message: string) => void;
export interface NextChildLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** The part of a `ChildProcess` the supervisor uses; tests inject a fake. */
export type NextChildProcess = EventEmitter & {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
};
export type SpawnNextChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => NextChildProcess;

export interface NextChildOptions {
  /** The `ui/` directory: the child's working directory and the home of `next-server.mjs`. */
  uiRoot: string;
  /** Run `next dev` (HMR, no build needed) instead of serving a production build. */
  dev: boolean;
  logger: NextChildLogger;
  /** Defaults to `process.execPath`. */
  command?: string;
  /** Defaults to the heap limit flag followed by `<uiRoot>/next-server.mjs`. */
  args?: readonly string[];
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** From spawn to the `ready` message. Defaults to 60 s. */
  readyDeadlineMs?: number;
  /** Restart delays: `initialMs` doubling to `maxMs`, reset after `healthyMs` of uptime. */
  backoff?: { initialMs?: number; maxMs?: number; healthyMs?: number };
  /** SIGTERM to SIGKILL on `stop()`. Defaults to 10 s. */
  stopGraceMs?: number;
  spawn?: SpawnNextChild;
}

export interface NextChild {
  /** Spawns the child. Calling it again has no effect. */
  start(): void;
  /** SIGTERM, then SIGKILL after the grace period. Resolves when the child is gone. */
  stop(): Promise<void>;
  state(): NextChildState;
  /** The child's loopback port while `ready`, otherwise null. */
  port(): number | null;
  /** Milliseconds a request may still wait for readiness; 0 unless `starting`. */
  remainingStartMs(): number;
  /** Resolves with `ready` or `failed` as soon as the state is no longer `starting`. */
  waitForSettled(): Promise<"ready" | "failed">;
}

const DEFAULT_READY_DEADLINE_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_MAX_OLD_SPACE_MB = 512;

/** Heap limit of the UI child, from `PAPERCLIP_UI_MAX_OLD_SPACE_MB`. */
export function resolveUiMaxOldSpaceMb(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PAPERCLIP_UI_MAX_OLD_SPACE_MB);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OLD_SPACE_MB;
}

function readReadyPort(message: unknown): number | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, port } = message as { type?: unknown; port?: unknown };
  if (type !== "ready" || typeof port !== "number") return null;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

interface Attempt {
  proc: NextChildProcess;
  readyAt: number | null;
  ended: boolean;
  deadlineTimer: NodeJS.Timeout | null;
  onStopped: (() => void) | null;
}

export function createNextChild(options: NextChildOptions): NextChild {
  const { logger: log, dev } = options;
  const readyDeadlineMs = options.readyDeadlineMs ?? DEFAULT_READY_DEADLINE_MS;
  const backoff = { initialMs: 1_000, maxMs: 30_000, healthyMs: 60_000, ...options.backoff };
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const spawnChild = options.spawn ?? (nodeSpawn as unknown as SpawnNextChild);
  const command = options.command ?? process.execPath;
  const parentEnv = options.env ?? process.env;
  const args = options.args ?? [
    `--max-old-space-size=${resolveUiMaxOldSpaceMb(parentEnv)}`,
    path.join(options.uiRoot, "next-server.mjs"),
  ];
  const childEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: dev ? "development" : "production",
    PORT: "0",
    HOSTNAME: "127.0.0.1",
  };

  let state: NextChildState = "starting";
  let port: number | null = null;
  let attempt: Attempt | null = null;
  let deadlineAt: number | null = null;
  let nextDelayMs = backoff.initialMs;
  let restartTimer: NodeJS.Timeout | null = null;
  let started = false;
  let stopping: Promise<void> | null = null;
  let isStopping = false;
  let waiters: Array<(settled: "ready" | "failed") => void> = [];

  const releaseWaiters = (settled: "ready" | "failed") => {
    const released = waiters;
    waiters = [];
    for (const release of released) release(settled);
  };

  const setState = (next: NextChildState, fields: Record<string, unknown>) => {
    if (state === next) return;
    state = next;
    (next === "failed" ? log.error : log.info)({ uiState: next, ...fields }, `UI child is ${next}`);
    if (next !== "starting") releaseWaiters(next);
  };

  const kill = (proc: NextChildProcess, signal: NodeJS.Signals) => {
    try {
      proc.kill(signal);
    } catch (err) {
      log.warn({ err, signal }, "could not signal the UI child");
    }
  };

  const endAttempt = (current: Attempt, reason: string, fields: Record<string, unknown> = {}) => {
    if (current.ended) return;
    current.ended = true;
    if (current.deadlineTimer) clearTimeout(current.deadlineTimer);
    if (attempt === current) attempt = null;
    port = null;
    deadlineAt = null;
    if (isStopping) {
      current.onStopped?.();
      return;
    }
    const wasReady = current.readyAt !== null;
    if (current.readyAt !== null && Date.now() - current.readyAt >= backoff.healthyMs) {
      nextDelayMs = backoff.initialMs;
    }
    const restartInMs = nextDelayMs;
    nextDelayMs = Math.min(nextDelayMs * 2, backoff.maxMs);
    // A child that had been ready comes back under `starting`: requests wait for
    // it. One that never became ready is `failed`, and stays so while retrying.
    setState(wasReady ? "starting" : "failed", { reason, restartInMs, ...fields });
    restartTimer = setTimeout(spawnAttempt, restartInMs);
    restartTimer.unref?.();
  };

  function spawnAttempt() {
    restartTimer = null;
    let proc: NextChildProcess;
    try {
      proc = spawnChild(command, args, {
        cwd: options.uiRoot,
        env: childEnv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (err) {
      // Synthesize an attempt so the failure takes the same retry path.
      const failed: Attempt = { proc: null as never, readyAt: null, ended: false, deadlineTimer: null, onStopped: null };
      endAttempt(failed, "spawn_failed", { err });
      return;
    }
    const current: Attempt = { proc, readyAt: null, ended: false, deadlineTimer: null, onStopped: null };
    attempt = current;
    deadlineAt = Date.now() + readyDeadlineMs;
    current.deadlineTimer = setTimeout(() => {
      if (current.ended || current.readyAt !== null) return;
      kill(proc, "SIGKILL");
      endAttempt(current, "ready_deadline", { readyDeadlineMs });
    }, readyDeadlineMs);
    current.deadlineTimer.unref?.();

    proc.on("message", (message: unknown) => {
      const readyPort = readReadyPort(message);
      if (current.ended || current.readyAt !== null || readyPort === null) return;
      if (current.deadlineTimer) clearTimeout(current.deadlineTimer);
      current.readyAt = Date.now();
      port = readyPort;
      deadlineAt = null;
      setState("ready", { port: readyPort });
    });
    proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      endAttempt(current, "exited", { code, signal });
    });
    proc.on("error", (err: Error) => {
      // A spawn failure leaves no pid and no exit event; other errors (a failed
      // signal or IPC write) leave the process alone.
      if (proc.pid === undefined) endAttempt(current, "spawn_error", { err });
      else log.warn({ err }, "UI child process error");
    });
  }

  return {
    start() {
      if (started || isStopping) return;
      started = true;
      spawnAttempt();
    },

    stop() {
      if (stopping) return stopping;
      isStopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      deadlineAt = null;
      port = null;
      state = "failed";
      releaseWaiters("failed");
      const current = attempt;
      stopping = new Promise<void>((resolve) => {
        if (!current || current.ended) {
          resolve();
          return;
        }
        const killTimer = setTimeout(() => {
          log.warn({ stopGraceMs }, "UI child did not exit after SIGTERM; sending SIGKILL");
          kill(current.proc, "SIGKILL");
        }, stopGraceMs);
        killTimer.unref?.();
        current.onStopped = () => {
          clearTimeout(killTimer);
          resolve();
        };
        kill(current.proc, "SIGTERM");
      });
      return stopping;
    },

    state: () => state,
    port: () => port,

    remainingStartMs() {
      if (state !== "starting") return 0;
      return deadlineAt === null ? readyDeadlineMs : Math.max(0, deadlineAt - Date.now());
    },

    waitForSettled() {
      if (state !== "starting") return Promise.resolve(state);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
