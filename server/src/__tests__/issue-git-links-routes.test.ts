import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueWorkProducts, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueGitLinkRoutes } from "../routes/issue-git-links.js";
import { issueGitLinkService } from "../services/issue-git-links.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue git route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue git routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-git-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Record<string, unknown>) {
    const git = issueGitLinkService(db, {
      statusAutomationEnabled: async () => false,
      resolvePullRequestDetails: async () => ({
        state: "open" as const,
        headRef: "feature/x",
        headSha: "abc",
        workProductState: "open" as const,
        draft: false,
        baseRef: "main",
        headRepository: "acme/app",
        defaultBranch: "main",
      }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    app.use("/api", issueGitLinkRoutes(db, { git }));
    app.use(errorHandler);
    return app;
  }

  const board = (companyIds: string[]) => ({ type: "board", userId: "user-1", companyIds, source: "session", isInstanceAdmin: false });

  function randomPrefix(): string {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    return `R${Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join("")}`;
  }

  async function seed(prefix = randomPrefix()) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Co ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Fix the login redirect", status: "todo",
      assigneeUserId: "user-1", identifier: `${prefix}-12`, issueNumber: 12,
    });
    return { companyId, issueId, prefix };
  }

  it("returns the branch to copy and an empty pull request list", async () => {
    const { companyId, issueId, prefix } = await seed();

    const res = await request(appFor(board([companyId]))).get(`/api/issues/${issueId}/git`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issueId,
      identifier: `${prefix}-12`,
      branch: { name: `${prefix}-12-fix-the-login-redirect`, command: `git switch -c ${prefix}-12-fix-the-login-redirect`, source: "default" },
      pullRequests: [],
      statusAutomation: { enabled: false },
    });
  });

  it("accepts the task identifier in the path", async () => {
    const { companyId, prefix } = await seed();

    const res = await request(appFor(board([companyId]))).get(`/api/issues/${prefix}-12/git`);

    expect(res.status).toBe(200);
    expect(res.body.identifier).toBe(`${prefix}-12`);
  });

  it("answers 404 for a task in another company, the same as a missing one", async () => {
    const mine = await seed();
    const theirs = await seed();
    const app = appFor(board([mine.companyId]));

    const other = await request(app).get(`/api/issues/${theirs.issueId}/git`);
    const missing = await request(app).get(`/api/issues/${randomUUID()}/git`);

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body).toEqual(missing.body);
  });

  it("links a pull request by URL, then answers 200 when the same one is linked again", async () => {
    const { companyId, issueId, prefix } = await seed();
    const app = appFor(board([companyId]));

    const first = await request(app).post(`/api/issues/${issueId}/git/pull-requests`).send({ url: "https://github.com/Acme/App/pull/7" });
    const second = await request(app).post(`/api/issues/${prefix}-12/git/pull-requests`).send({ repository: "acme/app", number: 7 });

    expect(first.status).toBe(201);
    expect(first.body.pullRequests).toHaveLength(1);
    expect(first.body.pullRequests[0]).toMatchObject({
      repository: "acme/app", number: 7, state: "open", closes: true, verified: true, linkedBy: "manual",
    });
    expect(second.status).toBe(200);
    expect(second.body.pullRequests).toHaveLength(1);
    expect(await db.select().from(issueWorkProducts)).toHaveLength(1);
    const log = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.git_pull_request_linked")));
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.details).toMatchObject({ repository: "acme/app", number: 7 });
  });

  it("rejects a body that gives neither a URL nor a repository and number", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(appFor(board([companyId]))).post(`/api/issues/${issueId}/git/pull-requests`).send({ closes: true });

    expect(res.status).toBe(400);
  });

  it("rejects a URL that is not a GitHub pull request", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(appFor(board([companyId]))).post(`/api/issues/${issueId}/git/pull-requests`).send({ url: "https://example.com/acme/app/pull/7" });

    expect(res.status).toBe(422);
    expect(await db.select().from(issueWorkProducts)).toEqual([]);
  });

  it("lets an agent link only on a task assigned to it", async () => {
    const { companyId, issueId } = await seed();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    for (const id of [agentId, otherAgentId]) {
      await db.insert(agents).values({
        id, companyId, name: `A${id.slice(0, 4)}`, role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
    }
    await db.update(issues).set({ assigneeUserId: null, assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    const agentActor = (id: string) => ({ type: "agent", agentId: id, companyId, source: "agent_key" });

    const denied = await request(appFor(agentActor(otherAgentId))).post(`/api/issues/${issueId}/git/pull-requests`).send({ repository: "acme/app", number: 7 });
    const allowed = await request(appFor(agentActor(agentId))).post(`/api/issues/${issueId}/git/pull-requests`).send({ repository: "acme/app", number: 7 });
    const read = await request(appFor(agentActor(otherAgentId))).get(`/api/issues/${issueId}/git`);

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(201);
    expect(read.status).toBe(200);
  });

  it("keeps an agent from another company out", async () => {
    const mine = await seed();
    const theirs = await seed();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId: theirs.companyId, name: "Other", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });

    const res = await request(appFor({ type: "agent", agentId, companyId: theirs.companyId, source: "agent_key" }))
      .post(`/api/issues/${mine.issueId}/git/pull-requests`)
      .send({ repository: "acme/app", number: 7 });

    expect(res.status).toBe(404);
    expect(await db.select().from(issueWorkProducts)).toEqual([]);
  });

  it("unlinks a pull request and records it", async () => {
    const { companyId, issueId } = await seed();
    const app = appFor(board([companyId]));
    const linked = await request(app).post(`/api/issues/${issueId}/git/pull-requests`).send({ repository: "acme/app", number: 7 });
    const workProductId = linked.body.pullRequests[0].workProductId as string;

    const removed = await request(app).delete(`/api/issues/${issueId}/git/pull-requests/${workProductId}`);
    const again = await request(app).delete(`/api/issues/${issueId}/git/pull-requests/${workProductId}`);
    const read = await request(app).get(`/api/issues/${issueId}/git`);

    expect(removed.status).toBe(204);
    expect(again.status).toBe(204);
    expect(read.body.pullRequests).toEqual([]);
    const log = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.git_pull_request_unlinked")));
    expect(log).toHaveLength(1);
  });

  it("answers 404 when unlinking an id that is not on this task", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(appFor(board([companyId]))).delete(`/api/issues/${issueId}/git/pull-requests/${randomUUID()}`);
    const malformed = await request(appFor(board([companyId]))).delete(`/api/issues/${issueId}/git/pull-requests/not-a-uuid`);

    expect(res.status).toBe(404);
    expect(malformed.status).toBe(404);
  });
});
