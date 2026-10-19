import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  routines,
} from "@paperclipai/db";
import type { AutomationWakeSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Automation wake coalesce test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres automation wake coalesce tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat automation wake coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-automation-wake-coalesce-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(routines);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(costEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Layers = {
    company?: AutomationWakeSettings;
    agent?: AutomationWakeSettings;
    routine?: AutomationWakeSettings;
  };

  async function seedLayers(layers: Layers) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      automationWakeSettings: layers.company ?? {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          ...layers.agent,
        },
      },
      permissions: {},
    });
    const routineId = randomUUID();
    if (layers.routine) {
      await db.insert(routines).values({
        id: routineId,
        companyId,
        title: "Nightly sweep",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        automationWakeSettings: layers.routine,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      ...(layers.routine ? { originKind: "routine_execution", originId: routineId } : {}),
      title: "Recurring recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  function seed(minSecondsBetweenAutomationWakes: number | undefined) {
    return seedLayers({
      agent: minSecondsBetweenAutomationWakes === undefined ? {} : { minSecondsBetweenAutomationWakes },
    });
  }

  async function seedAutomationRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    startedSecondsAgo: number;
  }) {
    const startedAt = new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1_000),
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_monitor_due" },
    });
  }

  function automationWake(agentId: string, issueId: string, reason: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: reason },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function runsForAgent(agentId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return rows.map((row) => ({ id: row.id, wakeReason: row.contextSnapshot?.wakeReason ?? null }));
  }

  async function deferredReceipts(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  }

  it("defers and merges automation wakes inside the window, then delivers once", async () => {
    const { companyId, agentId, issueId } = await seed(300);
    await seedAutomationRun({ companyId, agentId, issueId, startedSecondsAgo: 10 });

    expect(await automationWake(agentId, issueId, "issue_monitor_due")).toBeNull();
    expect(await automationWake(agentId, issueId, "issue_continuation_needed")).toBeNull();
    expect(await automationWake(agentId, issueId, "issue_monitor_due")).toBeNull();

    expect(await runsForAgent(agentId)).toHaveLength(1);
    const receipts = await deferredReceipts(agentId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.coalescedCount).toBe(2);
    const state = (receipts[0]?.payload as Record<string, unknown>)._paperclipAutomationWakeCoalesced as {
      reasons: string[];
    };
    expect(state.reasons).toEqual(["issue_monitor_due", "issue_continuation_needed"]);

    await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
    expect(await runsForAgent(agentId)).toHaveLength(1);
    expect(await deferredReceipts(agentId)).toHaveLength(1);

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.agentId, agentId));
    await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // The seeded run plus one delivered run; the merged wakes ran once. Follow-up
    // disposition-repair runs from the mock adapter are not automation wakes.
    const reasons = (await runsForAgent(agentId)).map((run) => run.wakeReason);
    expect(reasons.filter((reason) => reason === "issue_monitor_due")).toHaveLength(2);
    expect(reasons).not.toContain("issue_continuation_needed");
    expect(await deferredReceipts(agentId)).toHaveLength(0);
  });

  it("never coalesces an assignment wake", async () => {
    const { companyId, agentId, issueId } = await seed(300);
    await seedAutomationRun({ companyId, agentId, issueId, startedSecondsAgo: 10 });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run).not.toBeNull();
    expect(await deferredReceipts(agentId)).toHaveLength(0);
  });

  it("leaves automation wakes alone when the setting is off", async () => {
    const { companyId, agentId, issueId } = await seed(undefined);
    await seedAutomationRun({ companyId, agentId, issueId, startedSecondsAgo: 10 });

    expect(await automationWake(agentId, issueId, "issue_monitor_due")).not.toBeNull();
    expect(await deferredReceipts(agentId)).toHaveLength(0);
  });

  it("admits an automation wake when no automation run is inside the window", async () => {
    const { companyId, agentId, issueId } = await seed(300);
    await seedAutomationRun({ companyId, agentId, issueId, startedSecondsAgo: 900 });

    expect(await automationWake(agentId, issueId, "issue_monitor_due")).not.toBeNull();
    expect(await deferredReceipts(agentId)).toHaveLength(0);
  });

  describe("layered settings (company < agent < routine < wake type)", () => {
    async function wakeAfterRecentRun(layers: Layers, reason = "issue_monitor_due") {
      const { companyId, agentId, issueId } = await seedLayers(layers);
      await seedAutomationRun({ companyId, agentId, issueId, startedSecondsAgo: 10 });
      const run = await automationWake(agentId, issueId, reason);
      return { deferred: run === null && (await deferredReceipts(agentId)).length === 1, admitted: run !== null };
    }

    it("defaults: no layer set leaves the wake admitted, as before the feature", async () => {
      const result = await wakeAfterRecentRun({});
      expect(result).toEqual({ deferred: false, admitted: true });
    });

    it("a company window applies when nothing more specific is set", async () => {
      const result = await wakeAfterRecentRun({ company: { minSecondsBetweenAutomationWakes: 300 } });
      expect(result).toEqual({ deferred: true, admitted: false });
    });

    it("agent beats company in both directions", async () => {
      expect(
        await wakeAfterRecentRun({
          company: { minSecondsBetweenAutomationWakes: 300 },
          agent: { minSecondsBetweenAutomationWakes: 0 },
        }),
      ).toEqual({ deferred: false, admitted: true });
    });

    it("routine beats agent in both directions", async () => {
      expect(
        await wakeAfterRecentRun({
          agent: { minSecondsBetweenAutomationWakes: 0 },
          routine: { minSecondsBetweenAutomationWakes: 300 },
        }),
      ).toEqual({ deferred: true, admitted: false });
      expect(
        await wakeAfterRecentRun({
          agent: { minSecondsBetweenAutomationWakes: 300 },
          routine: { minSecondsBetweenAutomationWakes: 0 },
        }),
      ).toEqual({ deferred: false, admitted: true });
    });

    it("wake type beats the level-wide value of every level", async () => {
      expect(
        await wakeAfterRecentRun({
          agent: { minSecondsBetweenAutomationWakes: 300 },
          routine: { minSecondsBetweenAutomationWakes: 300, byWakeReason: { issue_monitor_due: 0 } },
        }),
      ).toEqual({ deferred: false, admitted: true });
      expect(
        await wakeAfterRecentRun({
          company: { byWakeReason: { issue_monitor_due: 300 } },
          routine: { minSecondsBetweenAutomationWakes: 0 },
        }),
      ).toEqual({ deferred: true, admitted: false });
    });

    it("a wake type override leaves other wake types on the level-wide value", async () => {
      const layers: Layers = { agent: { byWakeReason: { issue_monitor_due: 300 } } };
      expect(await wakeAfterRecentRun(layers, "issue_continuation_needed")).toEqual({
        deferred: false,
        admitted: true,
      });
    });
  });
});
