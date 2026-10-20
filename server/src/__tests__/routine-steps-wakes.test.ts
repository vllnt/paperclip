import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type { RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "hash") }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine step wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

describeEmbeddedPostgres("routine step wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-step-wakes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
  });

  const releaseSteps = (builderId: string): RoutineStep[] => [
    step("implement", [], { assigneeAgentId: builderId }),
    step("review", ["implement"]),
    step("lint", ["review"]),
    step("types", ["review"]),
    step("ship", ["lint", "types"]),
  ];

  async function dispatchRelease(makeSteps: (builderId: string) => RoutineStep[] = releaseSteps) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const newAgent = async (name: string) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
      return id;
    };
    const leadId = await newAgent("Lead");
    const builderId = await newAgent("Builder");

    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Release check",
        description: "Lead brief",
        assigneeAgentId: leadId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        steps: makeSteps(builderId),
      } as never,
      {},
    );
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const stepIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.originId, routine.id), eq(issues.originKind, "routine_step")));
    const byKey = new Map(stepIssues.map((issue) => [issue.title.replace("Step ", ""), issue]));
    return { companyId, leadId, rootId: run.linkedIssueId!, issueOf: (key: string) => byKey.get(key)!.id };
  }

  async function finish(issueIds: string[]) {
    for (const id of issueIds) {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, id));
    }
  }

  async function wakeRowsFor(issueId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_blockers_resolved"));
    return rows.filter((row) => (row.payload as { issueId?: string } | null)?.issueId === issueId);
  }

  it("wakes the next step when its predecessor is done, and the lead once after the last step", async () => {
    const fx = await dispatchRelease();
    const heartbeat = heartbeatService(db);

    const early = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(early.issueIds).toEqual([]);

    await finish([fx.issueOf("implement")]);
    const afterImplement = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(afterImplement.issueIds).toEqual([fx.issueOf("review")]);

    await finish([fx.issueOf("review")]);
    const afterReview = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect([...afterReview.issueIds].sort()).toEqual([fx.issueOf("lint"), fx.issueOf("types")].sort());

    await finish([fx.issueOf("lint")]);
    const afterLint = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(afterLint.issueIds).toEqual([]);
    expect(await wakeRowsFor(fx.issueOf("ship"))).toHaveLength(0);

    await finish([fx.issueOf("types")]);
    const afterTypes = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(afterTypes.issueIds).toEqual([fx.issueOf("ship")]);

    await finish([fx.issueOf("ship")]);
    const afterShip = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(afterShip.issueIds).toEqual([fx.rootId]);

    const again = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fx.companyId });
    expect(again.issueIds).toEqual([]);
    expect(await wakeRowsFor(fx.rootId)).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  });

  it("re-wakes a todo step whose wake was lost and leaves blocked steps and the blocked root alone in the stranded sweep", async () => {
    const fx = await dispatchRelease();
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();

    const blockedIds = [fx.rootId, fx.issueOf("review"), fx.issueOf("lint"), fx.issueOf("types"), fx.issueOf("ship")];
    const rows = await db.select({ id: issues.id, status: issues.status }).from(issues).where(eq(issues.companyId, fx.companyId));
    for (const id of blockedIds) {
      expect(rows.find((row) => row.id === id)?.status).toBe("blocked");
    }
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fx.companyId));
    const wokenIssueIds = wakes.map((wake) => (wake.payload as { issueId?: string } | null)?.issueId);
    for (const id of blockedIds) expect(wokenIssueIds).not.toContain(id);
    expect(wokenIssueIds).toContain(fx.issueOf("implement"));
  });

  it("runs the lead once when the two last steps are finished through the issue route at the same time", async () => {
    const fx = await dispatchRelease((builderId) => [
      step("left", [], { assigneeAgentId: builderId }),
      step("right", [], { assigneeAgentId: builderId }),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        actor: {
          type: "board",
          source: "local_implicit",
          userId: "local-board",
          companyIds: [fx.companyId],
          memberships: [{ companyId: fx.companyId, status: "active", membershipRole: "owner" }],
          isInstanceAdmin: true,
        },
      });
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    const leadRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fx.leadId));

    const responses = await Promise.all(
      ["left", "right"].map((key) => request(app).patch(`/api/issues/${fx.issueOf(key)}`).send({ status: "done" })),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const deadline = Date.now() + 15_000;
    while ((await leadRuns()).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await heartbeatService(db).drainActiveRunExecutions();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await heartbeatService(db).drainActiveRunExecutions();
    const stepWakeRuns = (await leadRuns()).filter((run) => {
      const snapshot = run.contextSnapshot as { wakeReason?: string } | null;
      return snapshot?.wakeReason === "issue_children_completed" || snapshot?.wakeReason === "issue_blockers_resolved";
    });
    expect(stepWakeRuns).toHaveLength(1);
    expect((stepWakeRuns[0]!.contextSnapshot as { issueId?: string } | null)?.issueId).toBe(fx.rootId);
  }, 45_000);
});
