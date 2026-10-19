import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, folders, projects, routineTriggers, routines } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GET /companies/:companyId/routines filters", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyA = randomUUID();
  const companyB = randomUUID();
  const ceo = randomUUID();
  const engineer = randomUUID();
  const otherCompanyAgent = randomUUID();
  const projectA = randomUUID();
  const folderOps = randomUUID();
  const ids: Record<string, string> = {};
  const base = new Date("2026-10-01T00:00:00Z").getTime();

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-routines-list-filters-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    for (const id of [companyA, companyB]) {
      await db.insert(companies).values({
        id,
        name: `Company ${id}`,
        issuePrefix: `R${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values([
      { id: ceo, companyId: companyA, name: "CEO", role: "ceo", adapterType: "process", adapterConfig: {} },
      { id: engineer, companyId: companyA, name: "Engineer", role: "engineer", adapterType: "process", adapterConfig: {} },
      { id: otherCompanyAgent, companyId: companyB, name: "Other", role: "engineer", adapterType: "process", adapterConfig: {} },
    ]);
    await db.insert(projects).values({ id: projectA, companyId: companyA, name: "Ops", status: "in_progress" });
    await db.insert(folders).values({ id: folderOps, companyId: companyA, kind: "routine", name: "Operations", slug: "operations" });

    const seed = async (
      key: string,
      values: Partial<typeof routines.$inferInsert> & { companyId: string; title: string },
      offsetMinutes: number,
      triggers: Array<{ kind: string; enabled?: boolean; archived?: boolean }> = [],
    ) => {
      const at = new Date(base + offsetMinutes * 60_000);
      const [row] = await db.insert(routines).values({ ...values, createdAt: at, updatedAt: at }).returning({ id: routines.id });
      ids[key] = row!.id;
      for (const trigger of triggers) {
        await db.insert(routineTriggers).values({
          companyId: values.companyId,
          routineId: row!.id,
          kind: trigger.kind,
          enabled: trigger.enabled ?? true,
          archived: trigger.archived ?? false,
        });
      }
    };
    await seed("weekly", { companyId: companyA, title: "Weekly CEO Review", description: "Summarise the week", assigneeAgentId: ceo, folderId: folderOps, projectId: projectA }, 1, [{ kind: "schedule" }]);
    await seed("deploy", { companyId: companyA, title: "Deploy hook", description: "Runs on GitHub push", assigneeAgentId: engineer }, 2, [{ kind: "webhook" }]);
    await seed("paused", { companyId: companyA, title: "Paused digest", description: "100% coverage_report", assigneeAgentId: engineer, status: "paused" }, 3, [{ kind: "schedule", enabled: false }]);
    await seed("manual", { companyId: companyA, title: "Ad hoc audit", description: null, assigneeAgentId: ceo, folderId: folderOps }, 4, [{ kind: "webhook", archived: true }]);
    await seed("api", { companyId: companyA, title: "API kickoff", description: "Started by the API from C:\\ops", assigneeAgentId: null }, 5, [{ kind: "api" }]);
    await seed("archived", { companyId: companyA, title: "Old weekly report", description: "Retired", assigneeAgentId: ceo, status: "archived" }, 6, [{ kind: "schedule" }]);
    await seed("other", { companyId: companyB, title: "Weekly CEO Review", description: "Other company", assigneeAgentId: otherCompanyAgent }, 7, [{ kind: "schedule" }]);
  }, 30_000);

  afterAll(async () => {
    await stopDb?.();
  });

  function app(actor: Express.Request["actor"] = { type: "board", userId: "board-user", source: "local_implicit" }) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", routineRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function listIds(query: string, companyId = companyA): Promise<string[]> {
    const res = await request(app()).get(`/api/companies/${companyId}/routines${query}`);
    expect(res.status).toBe(200);
    return res.body.map((row: { id: string }) => row.id);
  }

  const named = (...keys: string[]) => keys.map((key) => ids[key]);

  it("returns every routine of the company, newest first, when no filter is sent", async () => {
    expect(await listIds("")).toEqual(named("archived", "api", "manual", "paused", "deploy", "weekly"));
  });

  it("keeps the existing projectId filter", async () => {
    expect(await listIds(`?projectId=${projectA}`)).toEqual(named("weekly"));
  });

  it("matches q case-insensitively against the title and the description", async () => {
    expect(await listIds("?q=WEEKLY")).toEqual(named("archived", "weekly"));
    expect(await listIds("?q=github%20push")).toEqual(named("deploy"));
    expect(await listIds("?q=nothing-matches")).toEqual([]);
  });

  it("treats %, _ and \\ in q as literal characters", async () => {
    expect(await listIds(`?q=${encodeURIComponent("100%")}`)).toEqual(named("paused"));
    expect(await listIds(`?q=${encodeURIComponent("coverage_report")}`)).toEqual(named("paused"));
    expect(await listIds(`?q=${encodeURIComponent("%")}`)).toEqual(named("paused"));
    expect(await listIds(`?q=${encodeURIComponent("C:\\ops")}`)).toEqual(named("api"));
    expect(await listIds(`?q=${encodeURIComponent("\\")}`)).toEqual(named("api"));
  });

  it("filters by assignee agent", async () => {
    expect(await listIds(`?assigneeAgentId=${ceo}`)).toEqual(named("archived", "manual", "weekly"));
    expect(await listIds(`?assigneeAgentId=${engineer}`)).toEqual(named("paused", "deploy"));
  });

  it("filters by folder, with none for routines in no folder", async () => {
    expect(await listIds(`?folderId=${folderOps}`)).toEqual(named("manual", "weekly"));
    expect(await listIds("?folderId=none")).toEqual(named("archived", "api", "paused", "deploy"));
  });

  it("filters by status", async () => {
    expect(await listIds("?status=paused")).toEqual(named("paused"));
    expect(await listIds("?status=archived")).toEqual(named("archived"));
    expect(await listIds("?status=active")).toEqual(named("api", "manual", "deploy", "weekly"));
  });

  it("filters by trigger kind, counting disabled triggers and ignoring archived ones; manual means no trigger", async () => {
    expect(await listIds("?trigger=schedule")).toEqual(named("archived", "paused", "weekly"));
    expect(await listIds("?trigger=webhook")).toEqual(named("deploy"));
    expect(await listIds("?trigger=api")).toEqual(named("api"));
    expect(await listIds("?trigger=manual")).toEqual(named("manual"));
  });

  it("combines filters with AND", async () => {
    expect(await listIds(`?assigneeAgentId=${ceo}&trigger=schedule&status=active`)).toEqual(named("weekly"));
    expect(await listIds(`?q=weekly&folderId=none`)).toEqual(named("archived"));
  });

  it("treats empty and whitespace-only parameters as absent and ignores unknown ones", async () => {
    expect(await listIds("?q=&status=&unknown=1")).toEqual(named("archived", "api", "manual", "paused", "deploy", "weekly"));
    expect(await listIds("?q=%20%20&folderId=%20")).toEqual(named("archived", "api", "manual", "paused", "deploy", "weekly"));
  });

  it("accepts ids that are UUIDs but not version 4, like the other routine routes", async () => {
    expect(await listIds("?assigneeAgentId=22222222-2222-2222-2222-222222222222")).toEqual([]);
  });

  it("rejects invalid filter values with 400", async () => {
    for (const query of ["?status=sleeping", "?trigger=cron", "?assigneeAgentId=not-a-uuid", "?folderId=nope", `?q=${"x".repeat(201)}`, "?q=weekly%00", "?status=active&status=paused"]) {
      const res = await request(app()).get(`/api/companies/${companyA}/routines${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it("never returns another company's routines", async () => {
    expect(await listIds("?q=Weekly%20CEO")).toEqual(named("weekly"));
    expect(await listIds(`?assigneeAgentId=${otherCompanyAgent}`)).toEqual([]);
    expect(await listIds("", companyB)).toEqual(named("other"));
    const agentOfA = app({ type: "agent", agentId: ceo, companyId: companyA, source: "agent_key" });
    expect((await request(agentOfA).get(`/api/companies/${companyB}/routines?q=Weekly`)).status).toBe(403);
    const ownList = await request(agentOfA).get(`/api/companies/${companyA}/routines?assigneeAgentId=${ceo}`);
    expect(ownList.status).toBe(200);
    expect(ownList.body.map((row: { id: string }) => row.id)).toEqual(named("archived", "manual", "weekly"));
  });
});
