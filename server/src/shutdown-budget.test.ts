import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  describeStopTimeout,
  drainRunsInParallel,
  resolveShutdownBudgetMs,
  runBoundedShutdown,
  shutdownTerminationGraceMs,
  stopRunProcessForShutdown,
} from "./shutdown.js";

// These tests need no database: they guard the shutdown budget in the image
// build's `vitest run` line, so a change that lets a restart outlive its stop
// timeout fails CI.

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
  function steps(overrides: Partial<Parameters<typeof runBoundedShutdown>[0]["steps"]> = {}) {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
    };
    return {
      calls,
      steps: {
        closeHttpListener: record("closeHttpListener"),
        coordinateScheduler: record("coordinateScheduler"),
        flushTelemetry: record("flushTelemetry"),
        drainRuns: async (_deadlineAt: number) => {
          calls.push("drainRuns");
        },
        drainFinalizers: async (_timeoutMs: number) => {
          calls.push("drainFinalizers");
        },
        flushRunLogMirrors: record("flushRunLogMirrors"),
        finalize: record("finalize"),
        ...overrides,
      },
    };
  }

  it("stops accepting connections before it drains the runs", async () => {
    const listenerClosed = deferred();
    const { calls, steps: s } = steps({
      closeHttpListener: async () => {
        calls.push("closeHttpListener");
        await listenerClosed.promise;
      },
      drainRuns: async () => {
        calls.push("drainRuns");
        listenerClosed.resolve();
      },
    });
    const exit = vi.fn();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log: stubLogger(), exit });

    expect(calls.indexOf("closeHttpListener")).toBeLessThan(calls.indexOf("drainRuns"));
    expect(calls.at(-1)).toBe("finalize");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 0 within its budget when a run drain never finishes", async () => {
    const log = stubLogger();
    const exit = vi.fn();
    const { steps: s } = steps({ drainRuns: () => new Promise<void>(() => {}) });
    const started = Date.now();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 400, steps: s, log, exit });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "run_drain", outcome: "timed_out" }),
      "shutdown step finished",
    );
  });

  it("exits 0 at the hard deadline when the final teardown hangs", async () => {
    const log = stubLogger();
    const exit = vi.fn();
    const { steps: s } = steps({ finalize: () => new Promise<void>(() => {}) });

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 300, steps: s, log, exit });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "teardown", outcome: "timed_out" }),
      "shutdown step finished",
    );
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
      .map(([fields]) => fields as { step: string; outcome: string; durationMs: number });
    expect(finished.map((entry) => entry.step)).toEqual([
      "scheduler_quiesce",
      "telemetry_flush",
      "run_drain",
      "finalizer_drain",
      "run_log_flush",
      "http_listener_close",
      "teardown",
    ]);
    expect(finished.find((entry) => entry.step === "telemetry_flush")?.outcome).toBe("failed");
    for (const entry of finished) expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not exit the process when the caller keeps it alive", async () => {
    const exit = vi.fn();
    const { steps: s } = steps();

    await runBoundedShutdown({ signal: "SIGTERM", budgetMs: 5_000, steps: s, log: stubLogger(), exit: null });

    expect(exit).not.toHaveBeenCalled();
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
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { runId: row, outcome: "interrupted" };
      },
      signal: "SIGTERM",
      log: stubLogger(),
    });

    // One after another, four 300 ms runs take 1.2 s.
    expect(Date.now() - started).toBeLessThan(900);
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
