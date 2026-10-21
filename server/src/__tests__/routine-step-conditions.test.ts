import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
  projects,
  routineRuns,
} from "@paperclipai/db";
import {
  ROUTINE_STEP_SKIPPED_COMMENT,
  readRoutineStepsRunPayload,
  type RoutineStep,
  type RoutineStepCondition,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Acknowledged.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { logger } from "../middleware/logger.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "../services/issues.ts";
import {
  reconcileRoutineStepRun,
  routineStepConditionsBackstop,
  type RoutineStepRunReconcileDeps,
} from "../services/routine-steps.ts";
import { routineService } from "../services/routines.ts";

vi.setConfig({ testTimeout: 60000 });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine step condition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: RoutineStep["after"] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

const when = (stepKey: string, outcome: RoutineStepCondition) => ({ step: stepKey, when: outcome });

type Concurrency = "coalesce_if_active" | "skip_if_active" | "always_enqueue";

describeEmbeddedPostgres("routine step conditions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-step-conditions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
  });

  type Agents = { leadId: string; builderId: string; reviewerId: string };

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    const agentIds: Agents = {
      leadId: await newAgent("Lead"),
      builderId: await newAgent("Builder"),
      reviewerId: await newAgent("Reviewer"),
    };
    return { companyId, projectId, ...agentIds };
  }

  /** A company with one routine whose steps come from `makeSteps`. */
  async function seedRoutine(
    makeSteps: (agentIds: Agents) => RoutineStep[],
    concurrencyPolicy: Concurrency = "always_enqueue",
  ) {
    const company = await seedCompany();
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const routine = await svc.create(
      company.companyId,
      {
        projectId: company.projectId,
        goalId: null,
        parentIssueId: null,
        title: "Release check",
        description: "Lead brief",
        assigneeAgentId: company.leadId,
        priority: "medium",
        status: "active",
        concurrencyPolicy,
        catchUpPolicy: "skip_missed",
        steps: makeSteps(company),
      } as never,
      {},
    );
    return { ...company, svc, routine };
  }

  type SeededRoutine = Awaited<ReturnType<typeof seedRoutine>>;

  /** Dispatches one run of the routine and returns where its root and step issues are. */
  async function startRun(fx: SeededRoutine) {
    const run = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });
    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
    const recorded = readRoutineStepsRunPayload(stored!.triggerPayload);
    if (!recorded) throw new Error("The run recorded no steps");
    return {
      run,
      companyId: fx.companyId,
      rootId: run.linkedIssueId!,
      issueOf: (key: string) => recorded.stepIssueIds[key]!,
      target: { companyId: fx.companyId, rootIssueId: run.linkedIssueId!, routineRunId: run.id },
    };
  }

  type Run = Awaited<ReturnType<typeof startRun>>;

  /** The approval flow: a gated step, a branch for each outcome, and a step that joins them. */
  const gateSteps = ({ builderId, reviewerId }: Agents): RoutineStep[] => [
    step("review", [], { assigneeAgentId: reviewerId }),
    step("ship", [when("review", "done")]),
    step("rework", [when("review", "cancelled")], { assigneeAgentId: builderId }),
    step("announce", ["ship", "rework"]),
  ];

  async function setStatus(issueId: string, status: string) {
    await db
      .update(issues)
      .set({
        status,
        ...(status === "done" ? { completedAt: new Date() } : {}),
        ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
      })
      .where(eq(issues.id, issueId));
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row!.status;
  }

  async function blockersOf(issueId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.blockerId).sort();
  }

  async function commentsOn(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    return rows.map((row) => row.body);
  }

  /** Fake wake and post-commit deps that record what the reconcile asks for. */
  function recordingDeps(wakes: Array<{ agentId: string; issueId: string | null; reason: string | null | undefined }> = []) {
    const postCommitActions: IssuePostCommitAction[] = [];
    const deps: RoutineStepRunReconcileDeps = {
      issueSvc: issueService(db),
      heartbeat: {
        wakeup: async (agentId, opts) => {
          const issueId = typeof opts.payload?.issueId === "string" ? opts.payload.issueId : null;
          wakes.push({ agentId, issueId, reason: opts.reason });
          return null;
        },
      },
      executePostCommitActions: async (actions) => {
        postCommitActions.push(...actions);
      },
    };
    return { deps, wakes, postCommitActions };
  }

  const ids = (...runIssueIds: string[]) => [...runIssueIds].sort();

  describe("reconcileRoutineStepRun", () => {
    it("changes nothing while the gated step is still open", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
      expect(wakes).toEqual([]);
      expect(await statusOf(run.issueOf("rework"))).toBe("blocked");
      expect(await statusOf(run.issueOf("ship"))).toBe("blocked");
    });

    it("skips the rework branch when the gate is approved, and the join and the root stop waiting for it", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result.skippedIssueIds).toEqual([run.issueOf("rework")]);
      expect(await statusOf(run.issueOf("rework"))).toBe("cancelled");
      expect(await commentsOn(run.issueOf("rework"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
      expect(await blockersOf(run.issueOf("announce"))).toEqual([run.issueOf("ship")]);
      expect(await blockersOf(run.rootId)).toEqual(ids(run.issueOf("review"), run.issueOf("ship"), run.issueOf("announce")));
      // The join still waits for the merge step, so nothing is ready yet and nobody is woken.
      expect(result.releasedIssueIds.sort()).toEqual(ids(run.issueOf("announce"), run.rootId));
      expect(wakes).toEqual([]);
      // The approved branch is untouched: the usual blocker wake starts it.
      expect(await statusOf(run.issueOf("ship"))).toBe("blocked");
      expect(await blockersOf(run.issueOf("ship"))).toEqual([run.issueOf("review")]);
    });

    it("takes the rework branch when the board cancels the gated step, and wakes its agent", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "cancelled");
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result.skippedIssueIds).toEqual([run.issueOf("ship")]);
      expect(await statusOf(run.issueOf("ship"))).toBe("cancelled");
      expect(await commentsOn(run.issueOf("ship"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
      expect(await blockersOf(run.issueOf("rework"))).toEqual([]);
      expect(await statusOf(run.issueOf("rework"))).toBe("todo");
      expect(await blockersOf(run.issueOf("announce"))).toEqual([run.issueOf("rework")]);
      expect(await blockersOf(run.rootId)).toEqual(ids(run.issueOf("rework"), run.issueOf("announce")));
      expect(wakes).toEqual([{ agentId: fx.builderId, issueId: run.issueOf("rework"), reason: "issue_blockers_resolved" }]);
      expect(result.wokenIssueIds).toEqual([run.issueOf("rework")]);
    });

    it("writes an activity row for each skip and each released blocker set", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");
      const { deps } = recordingDeps();

      await reconcileRoutineStepRun(db, run.target, deps);

      const rows = await db.execute(
        sql`select entity_id, details from activity_log where company_id = ${run.companyId} and details->>'source' = 'routine_step_conditions'`,
      );
      const byEntity = new Map(rows.map((row) => [row.entity_id as string, row.details as Record<string, unknown>]));
      expect(byEntity.get(run.issueOf("rework"))).toMatchObject({ routineStepSkipped: true, status: "cancelled", stepKey: "rework" });
      expect(byEntity.get(run.issueOf("announce"))).toMatchObject({ stepKey: "announce" });
      expect(byEntity.get(run.rootId)).toMatchObject({ stepKey: null });
    });

    it("is idempotent: a second pass finds nothing more to do and wakes nobody twice", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "cancelled");
      const { deps, wakes } = recordingDeps();

      await reconcileRoutineStepRun(db, run.target, deps);
      const again = await reconcileRoutineStepRun(db, run.target, deps);

      expect(again).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
      expect(wakes).toHaveLength(1);
      expect(await commentsOn(run.issueOf("ship"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
    });

    it("changes nothing for a run whose steps have no conditions", async () => {
      const fx = await seedRoutine(({ builderId }) => [
        step("build", [], { assigneeAgentId: builderId }),
        step("test", ["build"], { assigneeAgentId: builderId }),
      ]);
      const run = await startRun(fx);
      await setStatus(run.issueOf("build"), "cancelled");
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
      expect(await statusOf(run.issueOf("test"))).toBe("blocked");
      expect(await blockersOf(run.issueOf("test"))).toEqual([run.issueOf("build")]);
      expect(wakes).toEqual([]);
    });

    it("changes nothing once the root is finished", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");
      await setStatus(run.rootId, "cancelled");
      const { deps } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result.skippedIssueIds).toEqual([]);
      expect(await statusOf(run.issueOf("rework"))).toBe("blocked");
    });

    it("does not touch a run of another company", async () => {
      const fx = await seedRoutine(gateSteps);
      const other = await seedCompany();
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");
      const { deps } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, { ...run.target, companyId: other.companyId }, deps);

      expect(result).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
      expect(await statusOf(run.issueOf("rework"))).toBe("blocked");
    });

    it("keeps a plain edge from a cancelled step blocked, and lets the next run dispatch once nothing else can move", async () => {
      const fx = await seedRoutine(
        ({ builderId }) => [
          step("gate", [], { assigneeAgentId: builderId }),
          step("branch", [when("gate", "done")], { assigneeAgentId: builderId }),
          step("build", [], { assigneeAgentId: builderId }),
          step("test", ["build"], { assigneeAgentId: builderId }),
        ],
        "coalesce_if_active",
      );
      const run = await startRun(fx);
      await setStatus(run.issueOf("gate"), "done");
      await setStatus(run.issueOf("build"), "cancelled");
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      // The cancel is not handled by any condition: the dependent stays blocked, visibly, with no cascade.
      expect(result).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
      expect(await statusOf(run.issueOf("test"))).toBe("blocked");
      expect(await blockersOf(run.issueOf("test"))).toEqual([run.issueOf("build")]);
      expect(wakes).toEqual([]);
      // The branch the approval opened can still run, so the run is live and a second dispatch coalesces into it.
      expect((await fx.svc.runRoutine(fx.routine.id, { source: "manual" })).status).toBe("coalesced");

      await setStatus(run.issueOf("branch"), "done");
      const next = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });
      expect(next.status).toBe("issue_created");
      expect(next.linkedIssueId).not.toBe(run.rootId);
    });

    it("does not hold the routine live for a cancel that a condition handles", async () => {
      const fx = await seedRoutine(gateSteps, "coalesce_if_active");
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "cancelled");

      // The rework branch is the way on: the run can still move, so the next dispatch coalesces into it.
      expect((await fx.svc.runRoutine(fx.routine.id, { source: "manual" })).status).toBe("coalesced");
      const { deps } = recordingDeps();
      await reconcileRoutineStepRun(db, run.target, deps);
      expect((await fx.svc.runRoutine(fx.routine.id, { source: "manual" })).status).toBe("coalesced");
    });

    it("leaves a block that a person owns alone, even when its conditions are not met", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await db
        .update(issues)
        .set({ unblockDescriptor: { owner: "board", action: "Choose how to rework this" } })
        .where(eq(issues.id, run.issueOf("rework")));
      await setStatus(run.issueOf("review"), "done");
      const { deps, wakes } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result.skippedIssueIds).toEqual([]);
      expect(await statusOf(run.issueOf("rework"))).toBe("blocked");
      expect(await commentsOn(run.issueOf("rework"))).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("moves the root to todo and wakes its lead once when every step it waited for ended or was skipped", async () => {
      const fx = await seedRoutine(({ reviewerId }) => [
        step("review", [], { assigneeAgentId: reviewerId }),
        step("ship", [when("review", "done")]),
      ]);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "cancelled");
      const { deps, wakes } = recordingDeps();

      await reconcileRoutineStepRun(db, run.target, deps);
      await reconcileRoutineStepRun(db, run.target, deps);

      expect(await statusOf(run.issueOf("ship"))).toBe("cancelled");
      expect(await blockersOf(run.rootId)).toEqual([]);
      expect(await statusOf(run.rootId)).toBe("todo");
      expect(wakes).toEqual([{ agentId: fx.leadId, issueId: run.rootId, reason: "issue_blockers_resolved" }]);
    });

    it("skips a whole chain behind a skipped step in one pass", async () => {
      const fx = await seedRoutine(({ reviewerId }) => [
        step("review", [], { assigneeAgentId: reviewerId }),
        step("rework", [when("review", "cancelled")]),
        step("recheck", ["rework"]),
        step("report", ["recheck"]),
      ]);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");
      const { deps } = recordingDeps();

      const result = await reconcileRoutineStepRun(db, run.target, deps);

      expect(result.skippedIssueIds.sort()).toEqual(ids(run.issueOf("rework"), run.issueOf("recheck"), run.issueOf("report")));
      for (const key of ["rework", "recheck", "report"]) expect(await statusOf(run.issueOf(key))).toBe("cancelled");
      expect(await blockersOf(run.rootId)).toEqual([run.issueOf("review")]);
    });

    it("lets two passes run at once and gives one result", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "cancelled");
      const wakes: Array<{ agentId: string; issueId: string | null; reason: string | null | undefined }> = [];

      const results = await Promise.all([
        reconcileRoutineStepRun(db, run.target, recordingDeps(wakes).deps),
        reconcileRoutineStepRun(db, run.target, recordingDeps(wakes).deps),
        reconcileRoutineStepRun(db, run.target, recordingDeps(wakes).deps),
      ]);

      expect(results.flatMap((result) => result.skippedIssueIds)).toEqual([run.issueOf("ship")]);
      expect(await commentsOn(run.issueOf("ship"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
      expect(wakes).toHaveLength(1);
      expect(await blockersOf(run.issueOf("rework"))).toEqual([]);
    });
  });

  describe("the post-commit action", () => {
    it("is queued when a step of a routine run ends, and for no other change", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      const svc = issueService(db);
      const queued: IssuePostCommitAction[] = [];

      await svc.update(run.issueOf("review"), { status: "in_progress" }, db, [], queued);
      expect(queued).toEqual([]);

      await svc.update(run.issueOf("review"), { status: "cancelled" }, db, [], queued);
      expect(queued).toEqual([
        { type: "reconcile_routine_steps", companyId: run.companyId, rootIssueId: run.rootId, routineRunId: run.run.id },
      ]);
    });

    it("is not queued for a task that is not a routine step", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      const queued: IssuePostCommitAction[] = [];

      await issueService(db).update(run.rootId, { status: "cancelled" }, db, [], queued);

      expect(queued).toEqual([]);
    });

    it("applies the conditions of the run once the step has committed", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);
      await setStatus(run.issueOf("review"), "done");

      await executeIssuePostCommitActions(db, [
        { type: "reconcile_routine_steps", companyId: run.companyId, rootIssueId: run.rootId, routineRunId: run.run.id },
      ]);

      expect(await statusOf(run.issueOf("rework"))).toBe("cancelled");
      expect(await commentsOn(run.issueOf("rework"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
    });

    it("logs a failed reconcile and leaves it to the backstop instead of failing the request", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        await expect(
          executeIssuePostCommitActions(db, [
            { type: "reconcile_routine_steps", companyId: "not-a-uuid", rootIssueId: randomUUID(), routineRunId: randomUUID() },
          ]),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ routineRunId: expect.any(String) }),
          "routine step conditions deferred to the periodic backstop",
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("through the issue route", () => {
    function appFor(companyId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        Object.assign(req, {
          actor: {
            type: "board",
            source: "local_implicit",
            userId: "local-board",
            companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "owner" }],
            isInstanceAdmin: true,
          },
        });
        next();
      });
      app.use("/api", issueRoutes(db, {} as never, {}));
      app.use(errorHandler);
      return app;
    }

    async function blockerWakesFor(issueId: string) {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_blockers_resolved"));
      return rows.filter((row) => (row.payload as { issueId?: string } | null)?.issueId === issueId);
    }

    async function waitFor(check: () => Promise<boolean>) {
      const deadline = Date.now() + 15_000;
      while (!(await check()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it("runs the approved path and skips the other branch when the board approves the gated step", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);

      const response = await request(appFor(fx.companyId)).patch(`/api/issues/${run.issueOf("review")}`).send({ status: "done" });

      expect(response.status).toBe(200);
      await waitFor(async () => (await statusOf(run.issueOf("rework"))) === "cancelled");
      await heartbeatService(db).drainActiveRunExecutions();
      expect(await statusOf(run.issueOf("rework"))).toBe("cancelled");
      expect(await commentsOn(run.issueOf("rework"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
      expect(await blockersOf(run.issueOf("announce"))).toEqual([run.issueOf("ship")]);
      expect(await blockerWakesFor(run.issueOf("rework"))).toHaveLength(0);
    });

    it("takes the rework branch when the board cancels the gated step, and wakes its agent once", async () => {
      const fx = await seedRoutine(gateSteps);
      const run = await startRun(fx);

      const response = await request(appFor(fx.companyId)).patch(`/api/issues/${run.issueOf("review")}`).send({ status: "cancelled" });

      expect(response.status).toBe(200);
      await waitFor(async () => (await blockerWakesFor(run.issueOf("rework"))).length > 0);
      await heartbeatService(db).drainActiveRunExecutions();
      expect(await statusOf(run.issueOf("ship"))).toBe("cancelled");
      expect(await commentsOn(run.issueOf("ship"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
      expect(await blockersOf(run.issueOf("rework"))).toEqual([]);
      expect(await statusOf(run.issueOf("rework"))).not.toBe("blocked");
      expect(await blockerWakesFor(run.issueOf("rework"))).toHaveLength(1);
    }, 45_000);
  });
});

describeEmbeddedPostgres("routine step condition backstop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // The backstop scans every company, so these tests run in a database of their own.
  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-step-backstop-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    // Close the runs of earlier tests: the backstop only looks at runs whose root still waits.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.originKind, "routine_execution"));
  });

  async function seedGateRuns(runCount: number, extra: { plainRuns?: number } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lead",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const create = (steps: RoutineStep[]) =>
      svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "Release check",
          description: "Lead brief",
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "always_enqueue",
          catchUpPolicy: "skip_missed",
          steps,
        } as never,
        {},
      );
    const gated = await create([
      step("review", []),
      step("ship", [when("review", "done")]),
      step("rework", [when("review", "cancelled")]),
    ]);
    const plain = await create([step("build", []), step("test", ["build"])]);

    const runs: Array<{ runId: string; rootId: string; issueOf: (key: string) => string }> = [];
    const start = async (routineId: string) => {
      const run = await svc.runRoutine(routineId, { source: "manual" });
      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      const recorded = readRoutineStepsRunPayload(stored!.triggerPayload)!;
      return { runId: run.id, rootId: run.linkedIssueId!, issueOf: (key: string) => recorded.stepIssueIds[key]! };
    };
    for (let index = 0; index < runCount; index += 1) runs.push(await start(gated.id));
    const plainRuns: typeof runs = [];
    for (let index = 0; index < (extra.plainRuns ?? 0); index += 1) plainRuns.push(await start(plain.id));
    runs.sort((left, right) => (left.runId < right.runId ? -1 : 1));
    return { companyId, runs, plainRuns };
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row!.status;
  }

  function backstopFor(options: { limit?: number } = {}) {
    const wakes: string[] = [];
    const deps: RoutineStepRunReconcileDeps = {
      issueSvc: issueService(db),
      heartbeat: {
        wakeup: async (_agentId, opts) => {
          if (typeof opts.payload?.issueId === "string") wakes.push(opts.payload.issueId);
          return null;
        },
      },
      executePostCommitActions: async () => undefined,
    };
    return { wakes, backstop: routineStepConditionsBackstop(db, deps, options) };
  }

  it("applies the conditions of a run whose step ended without the post-commit action", async () => {
    const { runs } = await seedGateRuns(1);
    const run = runs[0]!;
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, run.issueOf("review")));
    const { backstop, wakes } = backstopFor();

    const result = await backstop.reconcileOpenRuns();

    expect(result).toEqual({ checked: 1, skipped: 1, released: 2, woken: 1, failed: 0 });
    expect(await statusOf(run.issueOf("ship"))).toBe("cancelled");
    expect(await statusOf(run.issueOf("rework"))).toBe("todo");
    expect(wakes).toEqual([run.issueOf("rework")]);

    const again = await backstop.reconcileOpenRuns();
    expect(again).toEqual({ checked: 1, skipped: 0, released: 0, woken: 0, failed: 0 });
    expect(wakes).toHaveLength(1);
  });

  it("ignores a step whose run id is malformed instead of failing the pass", async () => {
    const { runs } = await seedGateRuns(2);
    await db.update(issues).set({ originRunId: "not-a-uuid" }).where(eq(issues.id, runs[1]!.issueOf("rework")));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, runs[0]!.issueOf("review")));
    const { backstop } = backstopFor();

    const result = await backstop.reconcileOpenRuns();

    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    expect(await statusOf(runs[0]!.issueOf("rework"))).toBe("cancelled");
  });

  it("looks only at runs that have conditions and whose root still waits", async () => {
    const { runs, plainRuns } = await seedGateRuns(2, { plainRuns: 1 });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, runs[0]!.rootId));
    const { backstop } = backstopFor();

    const result = await backstop.reconcileOpenRuns();

    expect(plainRuns).toHaveLength(1);
    expect(result.checked).toBe(1);
  });

  it("reconciles at most the cap per pass and moves on to the other runs on the next pass", async () => {
    const { runs } = await seedGateRuns(5);
    for (const run of runs) {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, run.issueOf("review")));
    }
    const { backstop } = backstopFor({ limit: 2 });
    const reworkStatuses = async () => Promise.all(runs.map((run) => statusOf(run.issueOf("rework"))));

    const first = await backstop.reconcileOpenRuns();
    expect(first).toMatchObject({ checked: 2, skipped: 2 });
    expect(await reworkStatuses()).toEqual(["cancelled", "cancelled", "blocked", "blocked", "blocked"]);

    const second = await backstop.reconcileOpenRuns();
    expect(second).toMatchObject({ checked: 2, skipped: 2 });
    expect(await reworkStatuses()).toEqual(["cancelled", "cancelled", "cancelled", "cancelled", "blocked"]);

    const third = await backstop.reconcileOpenRuns();
    expect(third).toMatchObject({ checked: 1, skipped: 1 });
    expect(await reworkStatuses()).toEqual(["cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);

    // The cursor starts over at the first run, which has nothing left to change.
    const fourth = await backstop.reconcileOpenRuns();
    expect(fourth).toMatchObject({ checked: 2, skipped: 0, released: 0 });
  });

  it("counts a run that fails and goes on with the rest", async () => {
    const { runs } = await seedGateRuns(2);
    for (const run of runs) {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, run.issueOf("review")));
    }
    let calls = 0;
    const issueSvc = issueService(db);
    const deps: RoutineStepRunReconcileDeps = {
      issueSvc: {
        ...issueSvc,
        update: async (...args: Parameters<typeof issueSvc.update>) => {
          calls += 1;
          if (calls === 1) throw new Error("update failed");
          return issueSvc.update(...args);
        },
      },
      heartbeat: { wakeup: async () => null },
      executePostCommitActions: async () => undefined,
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const result = await routineStepConditionsBackstop(db, deps).reconcileOpenRuns();

      expect(result).toMatchObject({ checked: 2, failed: 1, skipped: 1 });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ routineRunId: expect.any(String) }),
        "routine step condition backstop failed for one run; continuing with the rest",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
