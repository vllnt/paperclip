import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { pluginJobs } from "@paperclipai/db";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

vi.mock("../middleware/logger.js", () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return { logger: log };
});

type JobRow = typeof pluginJobs.$inferSelect;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending microtask run (the harness mocks only resolve in microtasks). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function dueJob(id: string, pluginId = "plugin-1"): JobRow {
  return {
    id,
    pluginId,
    jobKey: `job-${id}`,
    schedule: "* * * * *",
    status: "active",
    lastRunAt: null,
    nextRunAt: new Date(Date.now() - 1_000),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * In-memory harness. `calls` holds one entry per `runJob` RPC; the test
 * decides when each one settles. `pointerGate`, when set, holds back
 * `updateRunTimestamps` so a test can observe the window in which a job has
 * finished but its schedule pointer has not moved yet.
 */
function createHarness(options: { maxConcurrentJobs?: number; jobTimeoutMs?: number } = {}) {
  const rows = new Map<string, JobRow>();
  const calls: Array<{ jobKey: string; timeoutMs: number | undefined; gate: Deferred }> = [];
  const completions: Array<{ runId: string; status: string; error?: string }> = [];
  let runSeq = 0;
  const state: { pointerGate: Deferred | null } = { pointerGate: null };

  const db = {
    select: () => ({
      from: () => ({
        where: async () =>
          [...rows.values()].filter(
            (row) => row.status === "active" && row.nextRunAt !== null && row.nextRunAt <= new Date(),
          ),
      }),
    }),
  } as unknown as Db;

  const jobStore = {
    createRun: vi.fn(async () => ({ id: `run-${++runSeq}` })),
    markRunning: vi.fn(async () => {}),
    completeRun: vi.fn(async (runId: string, input: { status: string; error?: string }) => {
      completions.push({ runId, status: input.status, error: input.error });
    }),
    updateRunTimestamps: vi.fn(async (jobId: string, lastRunAt: Date, nextRunAt: Date | null) => {
      await state.pointerGate?.promise;
      const row = rows.get(jobId);
      if (row) rows.set(jobId, { ...row, lastRunAt, nextRunAt });
    }),
  } as unknown as PluginJobStore;

  const workerManager = {
    isRunning: () => true,
    call: vi.fn(
      async (
        _pluginId: string,
        _method: string,
        params: { job: { jobKey: string } },
        timeoutMs?: number,
      ) => {
        const gate = deferred();
        calls.push({ jobKey: params.job.jobKey, timeoutMs, gate });
        await gate.promise;
      },
    ),
  } as unknown as PluginWorkerManager;

  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
    maxConcurrentJobs: options.maxConcurrentJobs,
    jobTimeoutMs: options.jobTimeoutMs,
  });

  return {
    scheduler,
    jobStore,
    calls,
    completions,
    state,
    addJob: (job: JobRow) => rows.set(job.id, job),
    row: (id: string) => rows.get(id)!,
    callsFor: (jobKey: string) => calls.filter((call) => call.jobKey === jobKey),
    waitForCalls: (count: number) => vi.waitFor(() => expect(calls).toHaveLength(count)),
  };
}

describe("plugin job scheduler tick", () => {
  // Freeze the clock in mid-minute: the scheduler moves a job's pointer to the
  // next cron minute, and a test that crosses a minute boundary would see the
  // job due again.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T12:00:30.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns before a running job finishes", async () => {
    const h = createHarness();
    h.addJob(dueJob("slow"));

    await h.scheduler.tick();

    // The job is tracked before the tick returns, and its RPC is still pending.
    expect(h.scheduler.diagnostics().activeJobIds).toEqual(["slow"]);
    await h.waitForCalls(1);
    expect(h.completions).toHaveLength(0);

    h.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("dispatches a second due job on the next tick while a long job is still running", async () => {
    const h = createHarness();
    h.addJob(dueJob("slow", "plugin-1"));

    await h.scheduler.tick();
    await h.waitForCalls(1);

    // The long job still runs. A job of another plugin becomes due.
    h.addJob(dueJob("fast", "plugin-2"));
    await h.scheduler.tick();
    await h.waitForCalls(2);

    expect(h.callsFor("job-fast")).toHaveLength(1);
    expect(h.scheduler.diagnostics().activeJobIds.sort()).toEqual(["fast", "slow"]);
    // Still one call for the long job: the second tick did not re-run it.
    expect(h.callsFor("job-slow")).toHaveLength(1);

    h.callsFor("job-fast")[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobIds).toEqual(["slow"]));
    expect(h.completions).toEqual([{ runId: "run-2", status: "succeeded", error: undefined }]);

    h.callsFor("job-slow")[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("starts every due job of one tick without waiting for the first", async () => {
    const h = createHarness();
    h.addJob(dueJob("a"));
    h.addJob(dueJob("b"));
    h.addJob(dueJob("c"));

    await h.scheduler.tick();
    await h.waitForCalls(3);

    expect(h.calls.map((call) => call.jobKey).sort()).toEqual(["job-a", "job-b", "job-c"]);
    h.calls.forEach((call) => call.gate.resolve());
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("does not start a second run of a job that is still running", async () => {
    const h = createHarness();
    h.addJob(dueJob("slow"));

    await h.scheduler.tick();
    await h.scheduler.tick();
    await h.scheduler.tick();
    await settle();

    expect(h.callsFor("job-slow")).toHaveLength(1);
    expect(h.jobStore.createRun).toHaveBeenCalledTimes(1);

    h.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("keeps a finished job active until its schedule pointer has advanced", async () => {
    const h = createHarness();
    h.addJob(dueJob("slow"));
    h.state.pointerGate = deferred();

    await h.scheduler.tick();
    await h.waitForCalls(1);
    h.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.jobStore.updateRunTimestamps).toHaveBeenCalledTimes(1));

    // The run is recorded but the pointer is still in the past: the job is
    // still due and must not start again.
    expect(h.scheduler.diagnostics().activeJobIds).toEqual(["slow"]);
    await h.scheduler.tick();
    await settle();
    expect(h.callsFor("job-slow")).toHaveLength(1);

    h.state.pointerGate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
    expect(h.row("slow").nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    // The pointer moved to the next cron time: the job is no longer due.
    await h.scheduler.tick();
    await settle();
    expect(h.callsFor("job-slow")).toHaveLength(1);
  });

  it("respects maxConcurrentJobs across ticks", async () => {
    const h = createHarness({ maxConcurrentJobs: 2 });
    h.addJob(dueJob("a"));
    h.addJob(dueJob("b"));
    h.addJob(dueJob("c"));

    await h.scheduler.tick();
    await h.waitForCalls(2);

    await h.scheduler.tick();
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.scheduler.diagnostics().activeJobCount).toBe(2);

    h.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(1));

    await h.scheduler.tick();
    await h.waitForCalls(3);
    expect(new Set(h.calls.map((call) => call.jobKey)).size).toBe(3);

    h.calls.forEach((call) => call.gate.resolve());
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("passes the per-job timeout to the worker call and records a timed-out run as failed", async () => {
    const h = createHarness({ jobTimeoutMs: 1_234 });
    h.addJob(dueJob("slow"));
    h.addJob(dueJob("other"));

    await h.scheduler.tick();
    await h.waitForCalls(2);
    expect(h.calls.every((call) => call.timeoutMs === 1_234)).toBe(true);

    h.callsFor("job-slow")[0]!.gate.reject(new Error("RPC call timed out"));
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobIds).toEqual(["other"]));

    expect(h.completions).toEqual([{ runId: "run-1", status: "failed", error: "RPC call timed out" }]);
    // The other job is unaffected.
    expect(h.callsFor("job-other")).toHaveLength(1);

    h.callsFor("job-other")[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.scheduler.diagnostics().activeJobCount).toBe(0));
  });

  it("does not cancel or wait for in-flight jobs on stop", async () => {
    const h = createHarness();
    h.addJob(dueJob("slow"));

    h.scheduler.start();
    await h.scheduler.tick();
    await h.waitForCalls(1);
    h.scheduler.stop();

    expect(h.scheduler.diagnostics()).toMatchObject({ running: false, activeJobIds: ["slow"] });
    expect(h.completions).toHaveLength(0);

    h.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(h.completions).toHaveLength(1));
    expect(h.completions[0]).toMatchObject({ status: "succeeded" });
    expect(h.scheduler.diagnostics().activeJobCount).toBe(0);
  });
});
