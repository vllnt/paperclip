import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueDuplicateRoutes } from "../routes/issue-duplicates.js";
import { duplicateDetectionService } from "../services/duplicate-detection.js";
import { createJudgeClient } from "../services/judge-client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GET /issues/:id/duplicate-pairs hides other companies' issues", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const ownCompanyId = randomUUID();
  const otherCompanyId = randomUUID();
  const ownIssueId = randomUUID();
  const otherIssueId = randomUUID();
  const ownIdentifier = `OWN${ownCompanyId.slice(0, 4).toUpperCase()}-1`;
  const otherIdentifier = `OTH${otherCompanyId.slice(0, 4).toUpperCase()}-1`;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-duplicate-pairs-access-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    for (const [id, prefix] of [
      [ownCompanyId, ownIdentifier.split("-")[0]],
      [otherCompanyId, otherIdentifier.split("-")[0]],
    ] as const) {
      await db.insert(companies).values({
        id,
        name: `Company ${id}`,
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(issues).values([
      { id: ownIssueId, companyId: ownCompanyId, title: "Own issue", status: "todo", identifier: ownIdentifier },
      { id: otherIssueId, companyId: otherCompanyId, title: "Other issue", status: "todo", identifier: otherIdentifier },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopDb?.();
  });

  function appAs(actor: Express.Request["actor"]) {
    const detection = duplicateDetectionService({
      db,
      judge: createJudgeClient({
        config: { timeoutMs: 100, dailyCallCap: 0, zeroDataRetention: false },
        usage: { reserve: async () => false },
        resolveApiKey: async () => undefined,
      }),
      postSystemComment: async () => ({ id: randomUUID() }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueDuplicateRoutes(db, detection));
    app.use(errorHandler);
    return app;
  }

  const ownBoardUser = () =>
    appAs({
      type: "board",
      userId: "own-board-user",
      source: "session",
      companyIds: [ownCompanyId],
      memberships: [{ companyId: ownCompanyId, membershipRole: "owner", status: "active" }],
    });

  const ownAgent = () =>
    appAs({ type: "agent", agentId: randomUUID(), companyId: ownCompanyId, source: "agent_key" });

  it("answers another company's issue exactly like a missing issue, by id and by identifier", async () => {
    const app = ownBoardUser();
    const missingById = await request(app).get(`/api/issues/${randomUUID()}/duplicate-pairs`);
    const otherById = await request(app).get(`/api/issues/${otherIssueId}/duplicate-pairs`);
    const missingByIdentifier = await request(app).get("/api/issues/NOPE-999999/duplicate-pairs");
    const otherByIdentifier = await request(app).get(`/api/issues/${otherIdentifier}/duplicate-pairs`);

    expect(missingById.status).toBe(404);
    expect(otherById.status).toBe(404);
    expect(otherById.body).toEqual(missingById.body);
    expect(missingByIdentifier.status).toBe(404);
    expect(otherByIdentifier.status).toBe(404);
    expect(otherByIdentifier.body).toEqual(missingByIdentifier.body);
  });

  it("gives an agent key of another company the same 404", async () => {
    const app = ownAgent();
    const missing = await request(app).get(`/api/issues/${randomUUID()}/duplicate-pairs`);
    const other = await request(app).get(`/api/issues/${otherIssueId}/duplicate-pairs`);
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
  });

  it("still lists the pairs of the caller's own issue", async () => {
    const board = await request(ownBoardUser()).get(`/api/issues/${ownIssueId}/duplicate-pairs`);
    expect(board.status).toBe(200);
    expect(board.body).toEqual([]);
    const byIdentifier = await request(ownBoardUser()).get(`/api/issues/${ownIdentifier}/duplicate-pairs`);
    expect(byIdentifier.status).toBe(200);
    const agent = await request(ownAgent()).get(`/api/issues/${ownIssueId}/duplicate-pairs`);
    expect(agent.status).toBe(200);
  });
});
