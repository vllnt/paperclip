import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
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

/**
 * Statements that one board request sends to the database, counted on a warm
 * server with the seed below. Each budget sits a little above the count when it
 * was set, which the trailing comment records. A change that adds statements to
 * one of these requests, such as a query per row or a lost batch, fails here.
 * Raise a budget only with the reason in the commit.
 *
 * `rows` is the length of the list the request returns from the seed, so that
 * a request that finds nothing cannot pass its budget. `perRow` adds that many
 * statements to the budget for each listed row.
 */
const REQUESTS: Array<{
  name: string;
  path: (seeded: Seeded) => string;
  budget: number;
  rows?: number;
  perRow?: number;
}> = [
  { name: "health", path: () => "/api/health", budget: 4 }, // 3
  { name: "companies", path: () => "/api/companies", budget: 3, rows: 1 }, // 2
  { name: "agents", path: ({ companyId }) => `/api/companies/${companyId}/agents`, budget: 5, rows: 6 }, // 4
  { name: "issues list", path: ({ companyId }) => `/api/companies/${companyId}/issues`, budget: 27, rows: 40 }, // 24
  { name: "issue detail", path: ({ issueId }) => `/api/issues/${issueId}`, budget: 33 }, // 30
  { name: "issue comments", path: ({ issueId }) => `/api/issues/${issueId}/comments`, budget: 7, rows: 12 }, // 6
  { name: "routines", path: ({ companyId }) => `/api/companies/${companyId}/routines`, budget: 7, rows: 3 }, // 6
  // Equal to the count, not above it. Each list request imports the bundled
  // skills again from disk, and each skill ensures its bundled category folder
  // in its own folder-lock transaction: 12 statements per skill (8 listed here,
  // 27 + 12 * 8 = 123). The budget follows the number of bundled skills and
  // keeps the count per skill from growing; it is not a target.
  { name: "skills", path: ({ companyId }) => `/api/companies/${companyId}/skills`, budget: 27, perRow: 12 }, // 123
  { name: "plugins", path: () => "/api/plugins", budget: 2, rows: 0 }, // 1
  { name: "heartbeat runs", path: ({ companyId }) => `/api/companies/${companyId}/heartbeat-runs`, budget: 3, rows: 30 }, // 2
  { name: "dashboard", path: ({ companyId }) => `/api/companies/${companyId}/dashboard`, budget: 9 }, // 8
  { name: "sidebar badges", path: ({ companyId }) => `/api/companies/${companyId}/sidebar-badges`, budget: 5 }, // 4
];

describeEmbeddedPostgres("statements per board request", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let seeded!: Seeded;
  let recording: string[] | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-request-query-budgets-");
    const db = createDb(tempDb.connectionString);
    // postgres.js calls `options.debug` for each statement it sends, on every
    // connection of the pool.
    db.$client.options.debug = (_connection, statement) => {
      recording?.push(statement);
    };
    seeded = await seed(db);
    app = createApp(db);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(REQUESTS)("$name stays within its statement budget", async ({ name, path, budget: base, rows, perRow }) => {
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
      `${name} sent ${statements.length} statements (budget ${budget}):\n${statements.join("\n")}`,
    ).toBeLessThanOrEqual(budget);
  }, 30_000);
});

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "local-board",
      userName: "Local Board",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
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
