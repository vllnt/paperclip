import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createGateWorker, type GateProcessContext } from "../services/routine-gates/worker.ts";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@paperclipai/db", () => ({
  routineRuns: { id: "run.id", status: "status", gateClaimedAt: "claimed", gateAttempts: "attempts" },
  routines: { id: "routine.id" },
  routineTriggers: { id: "trigger.id" },
}));
vi.mock("drizzle-orm", () => {
  const op = (...args: unknown[]) => args;
  return { and: op, asc: op, desc: op, eq: op, inArray: op, isNotNull: op, isNull: op, lt: op, or: op, sql: op };
});

function runId(condition: unknown): string | undefined {
  if (!Array.isArray(condition)) return undefined;
  if (condition[0] === "run.id") return condition[1] as string;
  return condition.map(runId).find(Boolean);
}

describe("gate worker admission", () => {
  it("claims only after execution capacity is available, so queued runs cannot expire their claims", async () => {
    const runs = new Map([1, 2, 3].map((id) => [`run-${id}`, {
      id: `run-${id}`, routineId: "routine-1", triggerId: null, source: "schedule", status: "gating", gateAttempts: 0,
    }]));
    const routine = { id: "routine-1", companyId: "company-1", assigneeAgentId: "agent-1", gate: { timeoutSec: 120 } };
    const update = vi.fn(() => ({
      set: () => ({ where: (condition: unknown) => ({ returning: async () => {
        const row = runs.get(runId(condition)!);
        return row ? [{ ...row, gateAttempts: ++row.gateAttempts }] : [];
      } }) }),
    }));
    const db = {
      update,
      select: (projection?: unknown) => ({ from: (table: { id: string }) => {
        let condition: unknown;
        const query = {
          where: (value: unknown) => { condition = value; return query; },
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(
            projection ? [] : table.id === "run.id" ? [runs.get(runId(condition)!)] : [routine],
          ).then(resolve),
        };
        return query;
      } }),
    } as unknown as Db;
    const releases: Array<() => void> = [];
    const run = vi.fn(() => new Promise((resolve) => releases.push(() => resolve({
      result: { class: "skip", exitCode: 1 }, stdout: "", retryable: false,
    }))));
    const commit = vi.fn(async () => {});
    const context = {
      runner: { resolveEnvironmentId: async () => "environment-1", run },
      handlers: { commit, abandon: vi.fn() },
    } as unknown as GateProcessContext;
    const worker = createGateWorker(db);
    for (const id of runs.keys()) worker.kick(id, context);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(update).toHaveBeenCalledTimes(2);
    releases[0]!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    releases[1]!();
    releases[2]!();
    await worker.idle();
    expect(commit).toHaveBeenCalledTimes(3);
  });
});
