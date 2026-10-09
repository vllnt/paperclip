import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping run profile route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

const boardActor = (companyId: string): Express.Request["actor"] => ({
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  isInstanceAdmin: true,
  source: "local_implicit",
});

const agentActor = (companyId: string, agentId: string, runId?: string): Express.Request["actor"] => ({
  type: "agent", agentId, companyId, source: "agent_key", ...(runId ? { runId } : {}),
});

describeEmbeddedPostgres("issue run profile routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-profile-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await instanceSettingsService(db).updateGeneral({ companyRunTiers: {} });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Run profiles ${randomUUID()}`, issuePrefix: `RP${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    await instanceSettingsService(db).updateGeneral({
      companyRunTiers: {
        [companyId]: {
          tiers: {
            fast: { adapterType: "codex_local", model: "grok-4.7" },
            standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
          },
          agentAllowlist: ["fast"],
        },
      },
    });
    const mkAgent = async (name: string, adapterType: string, adapterConfig: Record<string, unknown>, fallbacks: unknown[] = []) => {
      const [agent] = await db.insert(agents).values({
        companyId, name, role: "engineer", status: "idle", adapterType, adapterConfig, runtimeConfig: {}, permissions: {}, fallbacks,
      }).returning();
      await db.insert(companyMemberships).values({
        companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member",
      });
      return agent!.id;
    };
    const manager = await mkAgent("Manager", "claude_local", { model: "claude-opus-5-5" });
    const worker = await mkAgent("Worker", "claude_local", { model: "claude-opus-5-5" }, [
      { adapterType: "codex_local", model: "gpt-5.5", env: { CODEX_HOME: "/srv/codex-home" } },
    ]);
    const codexWorker = await mkAgent("Codex worker", "codex_local", { model: "gpt-5.5" });
    const bareClaude = await mkAgent("Bare Claude", "claude_local", { model: "claude-opus-5-5" });
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: manager, permissionKey: "tasks:assign", scope: null, grantedByUserId: null,
    });
    return { companyId, manager, worker, codexWorker, bareClaude };
  }

  async function activitiesOf(companyId: string, action: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  }

  function createBody(assigneeAgentId: string, overrides: Record<string, unknown>) {
    return { title: `Chore ${randomUUID().slice(0, 6)}`, assigneeAgentId, assigneeAdapterOverrides: overrides };
  }

  it("lets a board user set a tier and an explicit target, logging before and after", async () => {
    const { companyId, worker } = await seed();
    const app = createApp(db, boardActor(companyId));
    const created = await request(app).post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { tier: "fast" } }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.assigneeAdapterOverrides).toEqual({ runProfile: { tier: "fast" } });

    const updated = await request(app).patch(`/api/issues/${created.body.id}`).send({
      assigneeAdapterOverrides: { runProfile: { adapterType: "codex_local", model: "gpt-5.5", effort: "low" } },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const logged = await activitiesOf(companyId, "issue.run_profile_updated");
    expect(logged.map((row) => row.details)).toMatchObject([
      { before: null, after: { tier: "fast" } },
      { before: { tier: "fast" }, after: { adapterType: "codex_local", model: "gpt-5.5", effort: "low" } },
    ]);
  });

  it("rejects an Anthropic model on a Codex harness with 400, in the body and for a model-only profile", async () => {
    const { companyId, worker, codexWorker } = await seed();
    const app = createApp(db, boardActor(companyId));
    const explicit = await request(app).post(`/api/companies/${companyId}/issues`)
      .send(createBody(worker, { runProfile: { adapterType: "codex_local", model: "claude-opus-5-5" } }));
    expect(explicit.status).toBe(400);
    const modelOnly = await request(app).post(`/api/companies/${companyId}/issues`)
      .send(createBody(codexWorker, { runProfile: { model: "claude-sonnet-5-5" } }));
    expect(modelOnly.status, JSON.stringify(modelOnly.body)).toBe(400);
    expect(JSON.stringify(modelOnly.body)).toContain("Anthropic models never run through codex_local");
    const unknownTier = await request(app).post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { tier: "turbo" } }));
    expect(unknownTier.status).toBe(400);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("refuses a profile on a harness the assignee has no credentials for", async () => {
    const { companyId, bareClaude } = await seed();
    const res = await request(createApp(db, boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues`).send(createBody(bareClaude, { runProfile: { tier: "fast" } }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { code: "run_profile_target_unconfigured" } });
  });

  it("lets an agent set an allowlisted tier on an issue it creates", async () => {
    const { companyId, manager, worker } = await seed();
    const res = await request(createApp(db, agentActor(companyId, manager)))
      .post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { tier: "fast" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAdapterOverrides).toEqual({ runProfile: { tier: "fast" } });
  });

  it("refuses an agent a tier outside the allowlist, an explicit target and a legacy model override, with activity", async () => {
    const { companyId, manager, worker } = await seed();
    const app = createApp(db, agentActor(companyId, manager));
    for (const overrides of [
      { runProfile: { tier: "standard" } },
      { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } },
      { adapterConfig: { model: "claude-opus-5-5" } },
    ]) {
      const res = await request(app).post(`/api/companies/${companyId}/issues`).send(createBody(worker, overrides));
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ details: { code: "run_profile_not_allowed" } });
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    const denied = await activitiesOf(companyId, "issue.run_profile_denied");
    expect(denied.map((row) => (row.details as { reason: string }).reason)).toEqual([
      "tier_not_allowlisted", "explicit_target_not_allowed", "explicit_target_not_allowed",
    ]);
  });

  it("refuses an agent raising its own task: clearing its tier, or touching a board-set profile", async () => {
    const { companyId, manager, worker } = await seed();
    const board = createApp(db, boardActor(companyId));
    const agent = createApp(db, agentActor(companyId, manager));
    const mine = await request(agent).post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { tier: "fast" } }));
    const clear = await request(agent).patch(`/api/issues/${mine.body.id}`).send({ assigneeAdapterOverrides: null });
    expect(clear.status, JSON.stringify(clear.body)).toBe(403);

    const boardSet = await request(board).post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { tier: "standard" } }));
    const lower = await request(agent).patch(`/api/issues/${boardSet.body.id}`)
      .send({ assigneeAdapterOverrides: { runProfile: { tier: "fast" } }, assigneeAgentId: worker });
    expect(lower.status).toBe(403);
    expect((await db.select().from(issues).where(eq(issues.id, boardSet.body.id)))[0]!.assigneeAdapterOverrides).toEqual({ runProfile: { tier: "standard" } });
  });

  it("lets an agent with agents:configure for the assignee set an explicit target", async () => {
    const { companyId, manager, worker } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: manager, permissionKey: "agents:configure", scope: { agentIds: [worker] }, grantedByUserId: null,
    });
    const res = await request(createApp(db, agentActor(companyId, manager)))
      .post(`/api/companies/${companyId}/issues`).send(createBody(worker, { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("keeps unrelated overrides and unchanged profiles open to the assigned agent", async () => {
    const { companyId, manager } = await seed();
    const created = await request(createApp(db, boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues`).send({
        title: "Self-assigned chore", assigneeAgentId: manager, assigneeAdapterOverrides: { runProfile: { tier: "standard" } },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: manager, invocationSource: "assignment", status: "running", startedAt: new Date(),
      contextSnapshot: { issueId: created.body.id, taskId: created.body.id },
    }).returning();
    const asManager = createApp(db, agentActor(companyId, manager, run!.id));
    const resubmit = await request(asManager).patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAdapterOverrides: { runProfile: { tier: "standard" }, useProjectWorkspace: true } });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect(await activitiesOf(companyId, "issue.run_profile_updated")).toHaveLength(1);

    const escalate = await request(asManager).patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAdapterOverrides: { runProfile: { tier: "fast" } } });
    expect(escalate.status).toBe(403);
    expect(escalate.body).toMatchObject({ details: { reason: "existing_profile_not_agent_set" } });
  });
});
