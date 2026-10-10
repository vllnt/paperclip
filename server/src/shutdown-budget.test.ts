import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpListenerForShutdown,
  describeStopTimeout,
  drainRunsInParallel,
  markServerStopping,
  refuseNewWorkWhileStopping,
  resetServerStoppingForTests,
  SHUTDOWN_FORCED_EXIT_CODE,
  type BoundedShutdownSteps,
  resolveShutdownBudgetMs,
  runBoundedShutdown,
  shutdownTerminationGraceMs,
  stopRunProcessForShutdown,
} from "./shutdown.js";

// These tests need no database: they guard the shutdown budget in the image
// build's `vitest run` line, so a change that lets a restart outlive its stop
// timeout fails CI.

function stubLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("resolveShutdownBudgetMs", () => {
  it("leaves 10 seconds of headroom under the stop timeout", () => {
    expect(resolveShutdownBudgetMs({ PAPERCLIP_STOP_TIMEOUT_MS: "60000" })).toBe(50_000);
    expect(resolveShutdownBudgetMs({ PAPERCLIP_STOP_TIMEOUT_MS: "120000" })).toBe(110_000);
  });

  it("assumes the deploy path's 60-second stop when the timeout is unset or invalid", () => {
    expect(resolveShutdownBudgetMs({})).toBe(50_000);
    expect(resolveShutdownBudgetMs({ PAPERCLIP_STOP_TIMEOUT_MS: "soon" })).toBe(50_000);
    expect(resolveShutdownBudgetMs({ PAPERCLIP_STOP_TIMEOUT_MS: "-5" })).toBe(50_000);
  });

  it("uses half of a short stop timeout, so the budget still ends before the kill", () => {
    expect(resolveShutdownBudgetMs({ PAPERCLIP_STOP_TIMEOUT_MS: "10000" })).toBe(5_000);
  });
});

describe("runBoundedShutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function steps(overrides: Partial<BoundedShutdownSteps> = {}) {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
    };
    const all: BoundedShutdownSteps = {
      refuseNewWork: () => {
        calls.push("refuseNewWork");
      },
      closeHttpListener: record("closeHttpListener"),
      coordinateScheduler: record("coordinateScheduler"),
      flushTelemetry: record("flushTelemetry"),
      drainRuns: async () => {
        calls.push("drainRuns");
      },
      drainFinalizers: async () => {
        calls.push("drainFinalizers");
      },
      flushRunLogMirrors: record("flushRunLogMirrors"),
      finalize: record("finalize"),
      ...overrides,
    };
    return { calls, steps: all };
  }

  it("refuses new work first, then keeps the listener open until the runs are drained", async () => {
    const { calls, steps: s } = steps();
    const exit = vi.fn();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log: stubLogger(), exit });

    expect(calls).toEqual([
      "refuseNewWork",
      "coordinateScheduler",
      "flushTelemetry",
      "drainRuns",
      "drainFinalizers",
      "flushRunLogMirrors",
      "closeHttpListener",
      "finalize",
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("serves a loopback callback while the runs drain, and closes the listener before it exits", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    let callbackStatus: number | null = null;
    const { steps: s } = steps({
      closeHttpListener: () => closeHttpListenerForShutdown({ server, signal: "SIGTERM", log: stubLogger() }),
      drainRuns: async () => {
        // A run finishing inside its grace reports back over loopback.
        const response = await fetch(`http://127.0.0.1:${port}/api/issues/1/comments`, { method: "POST" });
        callbackStatus = response.status;
      },
    });

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log: stubLogger(), exit: vi.fn() });

    expect(callbackStatus).toBe(200);
    expect(server.listening).toBe(false);
  });

  it("exits within its budget when a run drain never finishes", async () => {
    const log = stubLogger();
    const exit = vi.fn();
    const { steps: s } = steps({ drainRuns: () => new Promise<void>(() => {}) });
    const started = Date.now();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 1_000, steps: s, log, exit });

    // Generous margin: real timers on a loaded host.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "run_drain", outcome: "timed_out" }),
      "shutdown step finished",
    );
  });

  it("exits 70 at the hard deadline when the final teardown hangs, and 0 when it completes", async () => {
    const log = stubLogger();
    const forced = vi.fn();
    const { steps: hung } = steps({ finalize: () => new Promise<void>(() => {}) });

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 300, steps: hung, log, exit: forced });

    expect(forced).toHaveBeenCalledTimes(1);
    expect(forced).toHaveBeenCalledWith(SHUTDOWN_FORCED_EXIT_CODE);
    expect(SHUTDOWN_FORCED_EXIT_CODE).toBe(70);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "teardown", outcome: "timed_out" }),
      "shutdown step finished",
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "hard_deadline", code: 70 }),
      "shutdown exiting",
    );

    const clean = vi.fn();
    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: steps().steps, log: stubLogger(), exit: clean });
    expect(clean).toHaveBeenCalledWith(0);
  });

  it("aborts a scheduler step that outlives its 10 seconds, and starts the drain only after it settled", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let schedulerSignal: AbortSignal | null = null;
    const { steps: s } = steps({
      // A hot-restart preparation that is already writing takes 11 seconds and
      // does not stop at the abort: it must finish before the drain decides.
      coordinateScheduler: async (signal) => {
        schedulerSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        events.push(`preparation_done_aborted=${signal.aborted}`);
      },
      drainRuns: async () => {
        events.push("drain_started");
      },
    });

    const done = runBoundedShutdown({ signal: "SIGTERM", budgetMs: 50_000, steps: s, log: stubLogger(), exit: vi.fn() });
    await vi.advanceTimersByTimeAsync(12_000);
    await done;

    expect(schedulerSignal!.aborted).toBe(true);
    expect(events).toEqual(["preparation_done_aborted=true", "drain_started"]);
  });

  it("lets a preparation that honours the abort fall back to the drain at once", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { steps: s } = steps({
      coordinateScheduler: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          events.push("preparation_aborted_before_writing");
          resolve();
        }, { once: true });
      }),
      drainRuns: async () => {
        events.push("drain_started");
      },
    });

    const done = runBoundedShutdown({ signal: "SIGTERM", budgetMs: 50_000, steps: s, log: stubLogger(), exit: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_500);
    await done;

    expect(events).toEqual(["preparation_aborted_before_writing", "drain_started"]);
  });

  it("aborts the run drain at its deadline and waits for per-run drains in flight before the teardown", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let drainSignal: AbortSignal | null = null;
    const { steps: s } = steps({
      drainRuns: async (deadlineAt, signal) => {
        drainSignal = signal;
        // A per-run drain already writing ends 2 seconds after the deadline.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAt - Date.now()) + 2_000));
        events.push("per_run_drain_done");
      },
      finalize: async () => {
        events.push("teardown");
      },
    });

    const done = runBoundedShutdown({ signal: "SIGTERM", budgetMs: 50_000, steps: s, log: stubLogger(), exit: vi.fn() });
    await vi.advanceTimersByTimeAsync(40_000);
    await done;

    expect(drainSignal!.aborted).toBe(true);
    expect(events).toEqual(["per_run_drain_done", "teardown"]);
  });

  it("gives the run drain a deadline inside the budget, with time left for the teardown", async () => {
    let deadlineAt = 0;
    const { steps: s } = steps({
      drainRuns: async (deadline: number) => {
        deadlineAt = deadline;
      },
    });
    const started = Date.now();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 50_000, steps: s, log: stubLogger(), exit: vi.fn() });

    const elapsed = Date.now() - started;
    // 15 seconds of the 50-second budget stay for the teardown.
    expect(deadlineAt - started).toBeGreaterThanOrEqual(35_000);
    expect(deadlineAt - started).toBeLessThanOrEqual(35_000 + elapsed);
  });

  it("logs the start and the end of every step, with a duration and an outcome", async () => {
    const log = stubLogger();
    const { steps: s } = steps({
      flushTelemetry: async () => {
        throw new Error("collector down");
      },
    });

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log, exit: vi.fn() });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", budgetMs: 5_000 }),
      "shutdown started",
    );
    const inCallOrder = [log.info, log.error]
      .flatMap((fn) => fn.mock.calls.map((call, index) => ({ call, order: fn.mock.invocationCallOrder[index]! })))
      .sort((left, right) => left.order - right.order)
      .map(({ call }) => call);
    const finished = inCallOrder
      .filter(([, msg]) => msg === "shutdown step finished")
      .map(([fields]) => fields as { step: string; outcome?: string; durationMs?: number });
    expect(finished.map((entry) => entry.step)).toEqual([
      "refuse_new_work",
      "scheduler_quiesce",
      "telemetry_flush",
      "run_drain",
      "finalizer_drain",
      "run_log_flush",
      "http_listener_close",
      "teardown",
    ]);
    expect(finished.find((entry) => entry.step === "telemetry_flush")?.outcome).toBe("failed");
    for (const entry of finished.slice(1)) expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not exit the process, and arms no hard deadline, when the caller keeps it alive", async () => {
    const exit = vi.fn();
    const { steps: s } = steps();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log: stubLogger(), exit: null });

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("refuseNewWorkWhileStopping", () => {
  afterEach(() => {
    resetServerStoppingForTests();
  });

  async function request(method: string, path: string) {
    const app = express();
    app.use(refuseNewWorkWhileStopping());
    app.use((_req, res) => {
      res.status(200).json({ served: true });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return { status: response.status, retryAfter: response.headers.get("retry-after") };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("serves every request before the process is stopping", async () => {
    expect((await request("POST", "/api/agents/agent-1/wakeup")).status).toBe(200);
  });

  it("answers 503 with Retry-After to requests that only start new work while stopping", async () => {
    markServerStopping();

    for (const path of [
      "/api/agents/agent-1/wakeup",
      "/api/agents/agent-1/heartbeat/invoke",
      "/api/routines/routine-1/run",
      "/api/routine-triggers/public/abc/fire",
    ]) {
      expect(await request("POST", path)).toEqual({ status: 503, retryAfter: "30" });
    }
  });

  it("keeps serving run callbacks and reads while stopping", async () => {
    markServerStopping();

    expect((await request("POST", "/api/issues/issue-1/comments")).status).toBe(200);
    expect((await request("PATCH", "/api/issues/issue-1")).status).toBe(200);
    expect((await request("GET", "/api/agents/agent-1")).status).toBe(200);
  });
});

describe("shutdownTerminationGraceMs", () => {
  it("keeps the adapter grace when no deadline is set", () => {
    expect(shutdownTerminationGraceMs(20, undefined, 0)).toBe(20_000);
  });

  it("cuts the grace so SIGKILL and its 2-second verify end by the deadline", () => {
    expect(shutdownTerminationGraceMs(20, 10_000, 0)).toBe(8_000);
    expect(shutdownTerminationGraceMs(5, 60_000, 0)).toBe(5_000);
  });

  it("never goes below a short minimum when the deadline is already near", () => {
    expect(shutdownTerminationGraceMs(20, 1_000, 0)).toBe(100);
  });
});

describe("stopRunProcessForShutdown", () => {
  it("reports a run whose process cannot be stopped as terminate_failed", async () => {
    const log = stubLogger();
    const outcome = await stopRunProcessForShutdown({
      runId: "run-1",
      signal: "SIGTERM",
      log,
      stop: async () => {
        throw new Error("process remains alive after SIGKILL");
      },
    });

    expect(outcome).toEqual({ runId: "run-1", outcome: "terminate_failed", error: "process remains alive after SIGKILL" });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
      "failed to stop a run for graceful shutdown",
    );
  });

  it("returns null when the process stopped", async () => {
    await expect(stopRunProcessForShutdown({
      runId: "run-1", signal: "SIGTERM", log: stubLogger(), stop: async () => {},
    })).resolves.toBeNull();
  });
});

describe("drainRunsInParallel", () => {
  it("ends the runs at once, so the drain takes as long as its slowest run", async () => {
    const rows = ["a", "b", "c", "d"];
    const started = Date.now();

    const outcomes = await drainRunsInParallel({
      rows,
      runIdOf: (row) => row,
      drainOne: async (row) => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { runId: row, outcome: "interrupted" };
      },
      signal: "SIGTERM",
      log: stubLogger(),
    });

    // One after another, four 1-second runs take 4 seconds; generous margin for
    // real timers on a loaded host.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcomes.map((entry) => entry.runId).sort()).toEqual(rows);
  });

  it("keeps ending the other runs when one run fails, and gives every run one logged outcome", async () => {
    const log = stubLogger();
    const ended: string[] = [];

    const outcomes = await drainRunsInParallel({
      rows: ["stuck", "healthy"],
      runIdOf: (row) => row,
      drainOne: async (row) => {
        if (row === "stuck") {
          const failure = await stopRunProcessForShutdown({
            runId: row,
            signal: "SIGTERM",
            log,
            stop: async () => {
              throw new Error("process remains alive after SIGKILL");
            },
          });
          if (failure) return failure;
        }
        if (row === "healthy") ended.push(row);
        return { runId: row, outcome: "interrupted" };
      },
      signal: "SIGTERM",
      log,
    });

    expect(ended).toEqual(["healthy"]);
    expect(outcomes).toEqual(expect.arrayContaining([
      { runId: "healthy", outcome: "interrupted" },
      expect.objectContaining({ runId: "stuck", outcome: "terminate_failed" }),
    ]));
    expect(log.info.mock.calls.filter(([, msg]) => msg === "shutdown run outcome")).toHaveLength(2);
  });

  it("reports a run whose finalization throws as finalize_failed without stopping the others", async () => {
    const outcomes = await drainRunsInParallel({
      rows: ["broken", "healthy"],
      runIdOf: (row) => row,
      drainOne: async (row) => {
        if (row === "broken") throw new Error("database write failed");
        return { runId: row, outcome: "interrupted" };
      },
      signal: "SIGTERM",
      log: stubLogger(),
    });

    expect(outcomes).toEqual(expect.arrayContaining([
      { runId: "healthy", outcome: "interrupted" },
      { runId: "broken", outcome: "finalize_failed", error: "database write failed" },
    ]));
  });
});

describe("describeStopTimeout", () => {
  it("reads the stop timeout the deploy declares", () => {
    expect(describeStopTimeout({ PAPERCLIP_STOP_TIMEOUT_MS: "60000" })).toEqual({
      stopTimeoutMs: 60_000, budgetMs: 50_000, source: "env",
    });
  });

  it("says when it assumes the default, so the server can warn at boot", () => {
    expect(describeStopTimeout({})).toEqual({ stopTimeoutMs: 60_000, budgetMs: 50_000, source: "default" });
    expect(describeStopTimeout({ PAPERCLIP_STOP_TIMEOUT_MS: "soon" })).toEqual({
      stopTimeoutMs: 60_000, budgetMs: 50_000, source: "invalid",
    });
  });
});

describe("the deploy's stop timeout", () => {
  // The container runtime kills the process when its stop timeout ends; the
  // server sizes its shutdown budget from PAPERCLIP_STOP_TIMEOUT_MS. If the two
  // disagree, the budget is wrong: a longer variable lets the kill win, a shorter
  // one cuts the run grace for nothing.
  function appService(file: string) {
    const text = readFileSync(new URL(`../../deploy/${file}`, import.meta.url), "utf8");
    const start = text.indexOf("\n  paperclip:\n");
    const end = text.indexOf("\n  db:\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start, end);
  }

  for (const file of ["compose.template.yaml", "compose.yaml"]) {
    it(`matches stop_grace_period and PAPERCLIP_STOP_TIMEOUT_MS in ${file}`, () => {
      const service = appService(file);
      const grace = /\n    stop_grace_period: (\d+)s\n/.exec(service);
      const variable = /\n      PAPERCLIP_STOP_TIMEOUT_MS: "(\d+)"\n/.exec(service);
      expect(grace, "stop_grace_period on the app service").not.toBeNull();
      expect(variable, "PAPERCLIP_STOP_TIMEOUT_MS on the app service").not.toBeNull();
      expect(Number(grace![1]) * 1000).toBe(Number(variable![1]));
    });
  }
});
