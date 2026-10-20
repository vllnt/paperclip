import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import { routineService } from "../services/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine steps route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

describeEmbeddedPostgres("routine steps routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-steps-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const newAgent = async (name: string, permissions: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
      });
      return id;
    };
    const lowTrustPermissions = {
      authorizationPolicy: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, projectIds: [projectId] },
      },
    };
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    return { companyId, projectId, newAgent, lowTrustPermissions, svc };
  }

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { actor });
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const agentActor = (companyId: string, agentId: string) => ({
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
  });

  const boardActor = (companyId: string) => ({
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
  });

  describe("steps written by an agent", () => {
    it("carry a low-trust author's containment into the step issues of every run", async () => {
      const fx = await seed();
      const authorId = await fx.newAgent("Author", fx.lowTrustPermissions);
      const app = appFor(agentActor(fx.companyId, authorId));

      const created = await request(app)
        .post(`/api/companies/${fx.companyId}/routines`)
        .send({
          title: "Release",
          assigneeAgentId: authorId,
          projectId: fx.projectId,
          steps: [step("build"), step("ship", ["build"])],
        });

      expect(created.status).toBe(201);
      for (const stored of created.body.steps as RoutineStep[]) {
        expect(stored.executionPolicy?.authorizationPolicy).toMatchObject({
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          trustBoundary: { projectIds: [fx.projectId] },
        });
      }

      await fx.svc.runRoutine(created.body.id, { source: "manual" });
      const stepIssues = await db.select().from(issues).where(eq(issues.originId, created.body.id));
      const steps = stepIssues.filter((issue) => issue.originKind === "routine_step");
      expect(steps).toHaveLength(2);
      for (const issue of steps) {
        expect(issue.executionPolicy?.authorizationPolicy).toMatchObject({ trustPreset: LOW_TRUST_REVIEW_PRESET });
      }
    });

    it("keep the containment when a low-trust agent edits the steps and cannot reset it", async () => {
      const fx = await seed();
      const authorId = await fx.newAgent("Author", fx.lowTrustPermissions);
      const routine = await fx.svc.create(
        fx.companyId,
        { title: "Release", assigneeAgentId: authorId, projectId: fx.projectId, priority: "medium" } as never,
        {},
      );
      const app = appFor(agentActor(fx.companyId, authorId));

      const updated = await request(app)
        .patch(`/api/routines/${routine.id}`)
        .send({
          steps: [
            step("build", [], {
              executionPolicy: {
                mode: "normal",
                commentRequired: true,
                stages: [],
                authorizationPolicy: { trustPreset: "standard" },
              },
            }),
          ],
        });

      expect(updated.status).toBe(200);
      expect(updated.body.steps[0].executionPolicy.authorizationPolicy).toMatchObject({
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { projectIds: [fx.projectId] },
      });
    });

    it("are stored as written when the author is not low trust", async () => {
      const fx = await seed();
      const authorId = await fx.newAgent("Author");
      const app = appFor(agentActor(fx.companyId, authorId));

      const created = await request(app)
        .post(`/api/companies/${fx.companyId}/routines`)
        .send({ title: "Release", assigneeAgentId: authorId, projectId: fx.projectId, steps: [step("build")] });

      expect(created.status).toBe(201);
      expect(created.body.steps[0].executionPolicy).toBeUndefined();
    });
  });

  describe("an edit that leaves the steps and the default agent alone", () => {
    async function seedRoutineWithStaleStepAgent() {
      const fx = await seed();
      const leadId = await fx.newAgent("Lead");
      const doomedId = await fx.newAgent("Doomed");
      const routine = await fx.svc.create(
        fx.companyId,
        {
          title: "Release",
          assigneeAgentId: leadId,
          projectId: fx.projectId,
          priority: "medium",
          steps: [step("a", [], { assigneeAgentId: doomedId }), step("b", ["a"])],
        } as never,
        {},
      );
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, doomedId));
      return { fx, leadId, routine };
    }

    it("succeeds for a user without tasks:assign when the stored steps are sent back", async () => {
      const { fx, leadId, routine } = await seedRoutineWithStaleStepAgent();
      const app = appFor(boardActor(fx.companyId));
      const stored = await fx.svc.get(routine.id);

      const res = await request(app)
        .patch(`/api/routines/${routine.id}`)
        .send({ title: "Renamed", assigneeAgentId: leadId, steps: stored?.steps });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Renamed");
    });

    it("still needs tasks:assign when the steps change", async () => {
      const { fx, leadId, routine } = await seedRoutineWithStaleStepAgent();
      const app = appFor(boardActor(fx.companyId));
      const stored = await fx.svc.get(routine.id);

      const res = await request(app)
        .patch(`/api/routines/${routine.id}`)
        .send({ assigneeAgentId: leadId, steps: [...(stored?.steps ?? []), step("c", ["b"])] });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("tasks:assign");
    });
  });
});
