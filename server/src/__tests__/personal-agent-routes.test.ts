import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  personalAgentInstructionRevisions,
  personalAgents,
  personalAgentSkills,
  startEmbeddedPostgresTestDatabase,
  userAuditLog,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { PERSONAL_AGENT_MAX_SKILLS, PERSONAL_AGENT_TOOLS } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { personalAgentRoutes } from "../routes/personal-agent.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const markdownCatalogSkill = "paperclipai/bundled/docs/doc-maintenance";
const scriptCatalogSkill = "paperclipai/bundled/product/wireframe";

type ActorOverride = Express.Request["actor"];

function sessionActor(userId: string): ActorOverride {
  return { type: "board", userId, source: "session", companyIds: [companyId], memberships: [] };
}

describe("personal agent routes", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;

  function app(actor: ActorOverride) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    server.use("/api", personalAgentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const alice = () => app(sessionActor("alice"));
  const bob = () => app(sessionActor("bob"));

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-personal-agent-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    await db.delete(personalAgentSkills);
    await db.delete(personalAgentInstructionRevisions);
    await db.delete(personalAgents);
    await db.delete(userAuditLog);
  });

  afterAll(async () => {
    await database?.cleanup();
  }, 30_000);

  it("creates one agent with defaults per user, even under concurrent first reads", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(alice()).get("/api/personal-agent")));
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(responses.map((res) => res.body.id)).size).toBe(1);
    expect(responses[0]!.headers["cache-control"]).toBe("private, no-store");
    expect(responses[0]!.body).toMatchObject({ name: "Personal agent", instructions: "", instructionsRevision: 0 });
    expect(responses[0]!.body.toolPolicy.companyDefault).toBe("allow");
    expect(await db.select().from(personalAgents)).toHaveLength(1);
    expect(await db.select().from(userAuditLog).where(eq(userAuditLog.action, "personal_agent.created"))).toHaveLength(1);
  });

  it("serves only a signed-in user's session or own board key", async () => {
    expect((await request(app({ type: "none", source: "none" })).get("/api/personal-agent")).status).toBe(401);
    expect((await request(app({ type: "agent", agentId: "a1", companyId, source: "agent_key" })).get("/api/personal-agent")).status).toBe(403);
    expect((await request(app({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true })).get("/api/personal-agent")).status).toBe(403);
    expect((await request(app({ type: "board", userId: "carol", source: "cloud_tenant" })).get("/api/personal-agent")).status).toBe(403);
    const viaKey = await request(app({ type: "board", userId: "alice", source: "board_key", keyId: "key-1" })).get("/api/personal-agent");
    expect(viaKey.status).toBe(200);
    const [created] = await db.select().from(userAuditLog).where(eq(userAuditLog.userId, "alice"));
    expect(created).toMatchObject({ actorSource: "board_key", actorKeyId: "key-1" });
  });

  it("updates the name and tool policy and validates both", async () => {
    const policy = {
      enabledTools: ["list_companies", "list_issues"],
      companyDefault: "deny",
      companies: [{ companyId, enabled: true, tools: ["list_issues"] }],
    };
    const updated = await request(alice()).patch("/api/personal-agent").send({ name: "Chief of staff", toolPolicy: policy });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "Chief of staff", toolPolicy: policy });
    expect((await request(alice()).patch("/api/personal-agent").send({})).status).toBe(400);
    expect((await request(alice()).patch("/api/personal-agent").send({ toolPolicy: { ...policy, enabledTools: ["drop_tables"] } })).status).toBe(400);
    const [audit] = await db.select().from(userAuditLog).where(eq(userAuditLog.action, "personal_agent.updated"));
    expect(audit?.details).toMatchObject({ fields: ["name", "toolPolicy"], name: "Chief of staff" });
  });

  it("reads a stored policy with unknown tools by dropping them, and fails closed when it stays invalid", async () => {
    const { body } = await request(alice()).get("/api/personal-agent");
    const storePolicy = (policy: unknown) =>
      db.execute(sql`update personal_agents set tool_policy = ${JSON.stringify(policy)}::jsonb where id = ${body.id}`);
    await storePolicy({ enabledTools: ["list_issues", "retired_tool"], companyDefault: "allow", companies: [] });
    expect((await request(alice()).get("/api/personal-agent")).body.toolPolicy.enabledTools).toEqual(["list_issues"]);
    await storePolicy({ enabledTools: "all" });
    expect((await request(alice()).get("/api/personal-agent")).body.toolPolicy).toEqual({
      enabledTools: [],
      companyDefault: "deny",
      companies: [],
    });
  });

  it("saves instructions as revisions and refuses a stale base revision", async () => {
    const first = await request(alice()).put("/api/personal-agent/instructions").send({ body: "Be brief.", changeSummary: "start" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ instructions: "Be brief.", instructionsRevision: 1 });
    const second = await request(alice()).put("/api/personal-agent/instructions").send({ body: "Be briefer.", baseRevision: 1 });
    expect(second.body.instructionsRevision).toBe(2);
    const stale = await request(alice()).put("/api/personal-agent/instructions").send({ body: "Lost update", baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect((await request(alice()).get("/api/personal-agent")).body.instructions).toBe("Be briefer.");

    const revisions = await request(alice()).get("/api/personal-agent/instructions/revisions");
    expect(revisions.body.map((row: { revision: number }) => row.revision)).toEqual([2, 1]);
    expect(revisions.body[1]).toMatchObject({ changeSummary: "start", bodyLength: 9 });
    expect(revisions.body[0]).not.toHaveProperty("body");
    expect((await request(alice()).get("/api/personal-agent/instructions/revisions/1")).body.body).toBe("Be brief.");
    expect((await request(alice()).get("/api/personal-agent/instructions/revisions/9")).status).toBe(404);
    expect((await request(alice()).get("/api/personal-agent/instructions/revisions/abc")).status).toBe(404);
    expect((await request(bob()).get("/api/personal-agent/instructions/revisions/1")).status).toBe(404);
    expect(await db.select().from(userAuditLog).where(eq(userAuditLog.action, "personal_agent.instructions_updated"))).toHaveLength(2);
  });

  it("keeps skills private to their user", async () => {
    const created = await request(alice())
      .post("/api/personal-agent/skills")
      .send({ source: "custom", name: "Weekly Review!", description: "Summarize", markdown: "# Weekly review" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: "weekly-review", source: "custom", catalogKey: null, enabled: true });
    const skillId = created.body.id;

    for (const call of [
      request(bob()).get(`/api/personal-agent/skills/${skillId}`),
      request(bob()).patch(`/api/personal-agent/skills/${skillId}`).send({ enabled: false }),
      request(bob()).delete(`/api/personal-agent/skills/${skillId}`),
    ]) {
      expect((await call).status).toBe(404);
    }
    expect((await request(bob()).get("/api/personal-agent/skills")).body).toEqual([]);
    expect((await request(alice()).get("/api/personal-agent/skills/not-a-uuid")).status).toBe(404);

    const edited = await request(alice()).patch(`/api/personal-agent/skills/${skillId}`).send({ name: "Renamed", enabled: false });
    expect(edited.body).toMatchObject({ key: "weekly-review", name: "Renamed", enabled: false });
    expect((await request(alice()).get(`/api/personal-agent/skills/${skillId}`)).body.markdown).toBe("# Weekly review");
    const duplicate = await request(alice())
      .post("/api/personal-agent/skills")
      .send({ source: "custom", name: "weekly review", markdown: "# Again" });
    expect(duplicate.status).toBe(409);
    expect((await request(alice()).delete(`/api/personal-agent/skills/${skillId}`)).status).toBe(204);
    expect(await db.select().from(personalAgentSkills)).toHaveLength(0);
    const actions = (await db.select().from(userAuditLog)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["personal_agent.skill_created", "personal_agent.skill_updated", "personal_agent.skill_deleted"]));
  });

  it("copies markdown-only catalog skills and refuses skills with scripts or assets", async () => {
    const copied = await request(alice()).post("/api/personal-agent/skills").send({ source: "catalog", catalogRef: markdownCatalogSkill });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({ source: "catalog", catalogKey: markdownCatalogSkill, key: "doc-maintenance" });
    expect(copied.body.markdown.length).toBeGreaterThan(0);
    expect((await request(alice()).post("/api/personal-agent/skills").send({ source: "catalog", catalogRef: scriptCatalogSkill })).status).toBe(422);
    expect((await request(alice()).post("/api/personal-agent/skills").send({ source: "catalog", catalogRef: "nope/missing" })).status).toBe(404);
  });

  it("caps the number of skills", async () => {
    const { body } = await request(alice()).get("/api/personal-agent");
    await db.insert(personalAgentSkills).values(
      Array.from({ length: PERSONAL_AGENT_MAX_SKILLS }, (_, index) => ({
        personalAgentId: body.id,
        userId: "alice",
        key: `skill-${index}`,
        name: `Skill ${index}`,
        markdown: "x",
        source: "custom",
      })),
    );
    const over = await request(alice()).post("/api/personal-agent/skills").send({ source: "custom", name: "One more", markdown: "x" });
    expect(over.status).toBe(422);
  });

  it("lists the tool catalog and only the caller's audit rows", async () => {
    expect((await request(alice()).get("/api/personal-agent/tools")).body).toEqual(PERSONAL_AGENT_TOOLS);
    await request(alice()).put("/api/personal-agent/instructions").send({ body: "a" });
    await request(bob()).put("/api/personal-agent/instructions").send({ body: "b" });
    const audit = await request(alice()).get("/api/personal-agent/audit-log?limit=1");
    expect(audit.status).toBe(200);
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0].action).toBe("personal_agent.instructions_updated");
    const all = await request(alice()).get("/api/personal-agent/audit-log");
    expect(all.body.every((row: { details: Record<string, unknown> | null }) => row.details !== undefined)).toBe(true);
    expect(all.body).toHaveLength(2);
    expect((await request(alice()).get("/api/personal-agent/audit-log?limit=999")).status).toBe(400);
  });
});
