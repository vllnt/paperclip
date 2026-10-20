import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { healthRoutes } from "../routes/health.js";
import { issueRoutes } from "../routes/issues.js";
import { pluginRoutes } from "../routes/plugins.js";
import { routineRoutes } from "../routes/routines.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping request query budget tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Seeded = { companyId: string; issueId: string };
type Actor = "operator" | "member";

const MEMBER_USER_ID = "budget-member";

/**
 * postgres.js sends this once on each new pool connection, to learn the array
 * types. Whether a request opens a connection depends on how many statements it
 * sends at once, so the count leaves it out.
 */
const DRIVER_TYPE_FETCH =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b on b.oid = a.typelem where a.typcategory = 'A' group by b.oid, b.typarray order by b.oid";

/**
 * Statements that one board request sends to the database, counted on a warm
 * server with the seed below. Each budget sits a little above the count when it
 * was set, which the trailing comment records. A change that adds statements to
 * one of these requests, such as a query per row or a lost batch, fails here.
 * Raise a budget only with the reason in the commit.
 *
 * Actors: "operator" is the local operator (local_implicit, instance admin),
 * for whom authorization reads nothing. "member" is a signed-in user with a
 * plain membership in the company, for whom authorization and membership
 * lookups read the database; it covers the requests where that adds statements.
 *
 * `rows` is the length of the list the request returns from the seed, so that
 * a request that finds nothing cannot pass its budget. `perRow` adds that many
 * statements to the budget for each listed row.
 */
const REQUESTS: Array<{
  name: string;
  actor: Actor;
  path: (seeded: Seeded) => string;
  budget: number;
  rows?: number;
  perRow?: number;
}> = [
  { name: "health", actor: "operator", path: () => "/api/health", budget: 4 }, // 3
  { name: "companies", actor: "operator", path: () => "/api/companies", budget: 3, rows: 1 }, // 2
  { name: "agents", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/agents`, budget: 5, rows: 6 }, // 4
  { name: "issues list", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/issues`, budget: 27, rows: 40 }, // 24
  { name: "issue detail", actor: "operator", path: ({ issueId }) => `/api/issues/${issueId}`, budget: 33 }, // 30
  { name: "issue comments", actor: "operator", path: ({ issueId }) => `/api/issues/${issueId}/comments`, budget: 7, rows: 12 }, // 6
  { name: "routines", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/routines`, budget: 7, rows: 3 }, // 6
  // Equal to the count, not above it. Each list request imports the bundled
  // skills again from disk, and each skill ensures its bundled category folder
  // in its own folder-lock transaction: 12 statements per skill (8 listed here,
  // 27 + 12 * 8 = 123). The budget follows the number of bundled skills and
  // keeps the count per skill from growing; it is not a target.
  { name: "skills", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/skills`, budget: 27, perRow: 12 }, // 123
  { name: "plugins", actor: "operator", path: () => "/api/plugins", budget: 2, rows: 0 }, // 1
  { name: "heartbeat runs", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/heartbeat-runs`, budget: 3, rows: 30 }, // 2
  { name: "dashboard", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/dashboard`, budget: 9 }, // 8
  { name: "sidebar badges", actor: "operator", path: ({ companyId }) => `/api/companies/${companyId}/sidebar-badges`, budget: 5 }, // 4
  // Includes 2 statements per agent: the list authorizes each agent on its own
  // (filterAgentsForActor in routes/agents.ts). The budget is not a target.
  { name: "agents", actor: "member", path: ({ companyId }) => `/api/companies/${companyId}/agents`, budget: 17, rows: 6 }, // 16
  { name: "issues list", actor: "member", path: ({ companyId }) => `/api/companies/${companyId}/issues`, budget: 29, rows: 40 }, // 26
  { name: "issue detail", actor: "member", path: ({ issueId }) => `/api/issues/${issueId}`, budget: 35 }, // 32
  { name: "issue comments", actor: "member", path: ({ issueId }) => `/api/issues/${issueId}/comments`, budget: 9, rows: 12 }, // 8
  { name: "heartbeat runs", actor: "member", path: ({ companyId }) => `/api/companies/${companyId}/heartbeat-runs`, budget: 5, rows: 30 }, // 4
  { name: "sidebar badges", actor: "member", path: ({ companyId }) => `/api/companies/${companyId}/sidebar-badges`, budget: 7 }, // 6
];

describeEmbeddedPostgres("statements per board request", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let apps!: Record<Actor, express.Express>;
  let seeded!: Seeded;
  let recording: string[] | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-request-query-budgets-");
    const db = createDb(tempDb.connectionString);
    // postgres.js calls `options.debug` for each statement it sends, on every
    // connection of the pool.
    db.$client.options.debug = (_connection, statement) => {
      if (statement.replace(/\s+/g, " ").trim() !== DRIVER_TYPE_FETCH) recording?.push(statement);
    };
    seeded = await seed(db);
    apps = {
      operator: createApp(db, {
        type: "board",
        userId: "local-board",
        userName: "Local Board",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      }),
      member: createApp(db, {
        type: "board",
        userId: MEMBER_USER_ID,
        userName: "Member",
        userEmail: null,
        companyIds: [seeded.companyId],
        memberships: [{ companyId: seeded.companyId, membershipRole: "member", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      }),
    };
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(REQUESTS)("$name as $actor stays within its statement budget", async ({ name, actor, path, budget: base, rows, perRow }) => {
    const app = apps[actor];
    const url = path(seeded);
    // The first request warms the caches; count the second.
    await request(app).get(url).expect(200);
    const statements: string[] = [];
    recording = statements;
    let body: unknown;
    try {
      body = (await request(app).get(url).expect(200)).body;
    } finally {
      recording = null;
    }
    if (rows !== undefined) expect(body).toHaveLength(rows);
    let budget = base;
    if (perRow !== undefined) {
      expect(Array.isArray(body) && body.length > 0, `${name} listed nothing`).toBe(true);
      budget += perRow * (body as unknown[]).length;
    }
    expect(
      statements.length,
      `${name} as ${actor} sent ${statements.length} statements (budget ${budget}):\n${statements.join("\n")}`,
    ).toBeLessThanOrEqual(budget);
  }, 30_000);
});

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/health", healthRoutes(db, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  }));
  app.use("/api/companies", companyRoutes(db));
  app.use("/api", companySkillRoutes(db));
  app.use("/api", agentRoutes(db));
  app.use("/api", routineRoutes(db));
  app.use("/api", dashboardRoutes(db));
  app.use("/api", sidebarBadgeRoutes(db));
  app.use("/api", issueRoutes(db, {} as never));
  app.use("/api", pluginRoutes(db, { installPlugin: vi.fn() } as never));
  app.use(errorHandler);
  return app;
}

/** A small working company: agents with runs, assigned issues, a discussion, routines. */
async function seed(db: Db) {
  const [company] = await db
    .insert(companies)
    .values({ name: `Budget ${randomUUID()}`, issuePrefix: `QB${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning();
  const companyId = company!.id;
  await db.insert(companyMemberships).values({
    companyId, principalType: "user", principalId: MEMBER_USER_ID, status: "active", membershipRole: "member",
  });
  const agentRows = await db
    .insert(agents)
    .values(Array.from({ length: 6 }, (_, index) => ({
      companyId,
      name: `Agent ${index}`,
      role: index === 0 ? "ceo" : "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false } },
      permissions: {},
    })))
    .returning();
  const statuses = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as const;
  const issueRows = await db
    .insert(issues)
    .values(Array.from({ length: 40 }, (_, index) => ({
      companyId,
      title: `Issue ${index}`,
      status: statuses[index % statuses.length]!,
      assigneeAgentId: agentRows[index % agentRows.length]!.id,
      issueNumber: index + 1,
      identifier: `${company!.issuePrefix}-${index + 1}`,
    })))
    .returning();
  const issueId = issueRows[2]!.id;
  await db.insert(issueComments).values(Array.from({ length: 12 }, (_, index) => ({
    companyId,
    issueId,
    authorAgentId: agentRows[index % agentRows.length]!.id,
    body: `Comment ${index}`,
  })));
  await db.insert(routines).values(Array.from({ length: 3 }, (_, index) => ({
    companyId,
    title: `Routine ${index}`,
    assigneeAgentId: agentRows[index]!.id,
  })));
  const runStatuses = ["succeeded", "failed", "succeeded", "running", "queued"] as const;
  await db.insert(heartbeatRuns).values(Array.from({ length: 30 }, (_, index) => ({
    companyId,
    agentId: agentRows[index % agentRows.length]!.id,
    status: runStatuses[index % runStatuses.length]!,
    invocationSource: "assignment",
    contextSnapshot: { issueId: issueRows[index % issueRows.length]!.id },
  })));
  return { companyId, issueId };
}
