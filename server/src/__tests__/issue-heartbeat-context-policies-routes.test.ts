import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyPolicies,
  documentRevisions,
  documents,
  issueComments,
  issues,
  projects,
  createDb,
  type Db,
} from "@paperclipai/db";
import type { CreateCompanyPolicy } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { companyPolicyService } from "../services/company-policies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-context policy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /issues/:id/heartbeat-context policies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    // A local worktree instance env file sets this and filters the agent inbox; tests must not depend on it.
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-policies-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyPolicies);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    const prefix = `P${randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: `${name} ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Agent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [project, otherProject] = await db.insert(projects).values([{ companyId, name: "Site" }, { companyId, name: "Other" }]).returning();
    const policies = companyPolicyService(db as Db);
    const create = (input: Partial<CreateCompanyPolicy> & { key: string; title: string }) =>
      policies.create(companyId, { status: "active", body: "SECRET-BODY-TEXT", ...input } as CreateCompanyPolicy, { userId: "board-user" });
    const createIssue = async (values: { title: string; description?: string | null; projectId?: string | null }) => {
      const [issue] = await db
        .insert(issues)
        .values({
          companyId, status: "todo", priority: "medium", identifier: `${prefix}-1`, issueNumber: 1,
          assigneeAgentId: agentId, projectId: null, ...values,
        })
        .returning();
      return issue!;
    };
    const client = request(
      (() => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          (req as unknown as { actor: Record<string, unknown> }).actor = { type: "agent", source: "agent_key", companyId, agentId };
          next();
        });
        app.use("/api", issueRoutes(db as Db, {} as never, {}));
        app.use(errorHandler);
        return app;
      })(),
    );
    return { companyId, project: project!, otherProject: otherProject!, create, createIssue, client };
  }

  it("returns the index of the company, project and mentioned policies, with no body", async () => {
    const { project, otherProject, create, createIssue, client } = await seedCompany("Index");
    await create({ key: "company-rule", title: "Company rule", summary: "Applies everywhere." });
    await create({ key: "project-rule", title: "Project rule", projectId: project.id });
    // A policy of another project applies to this task only because the task text names it.
    await create({ key: "elsewhere", title: "Elsewhere", projectId: otherProject.id });
    await create({ key: "still-draft", title: "A draft title", status: "draft" });
    const issue = await createIssue({
      title: "Task",
      description: "See [x](policy://elsewhere) and [y](policy://still-draft) and [z](policy://no-such-key).",
      projectId: project.id,
    });

    const res = await client.get(`/api/issues/${issue.id}/heartbeat-context`);

    expect(res.status).toBe(200);
    expect(res.body.policies.moreCount).toBe(0);
    expect(typeof res.body.policies.digest).toBe("string");
    const byKey = new Map<string, Record<string, unknown>>(
      res.body.policies.entries.map((entry: Record<string, unknown>) => [entry.key as string, entry]),
    );
    expect(byKey.get("company-rule")).toMatchObject({ state: "active", scope: "company", via: "scope", title: "Company rule", summary: "Applies everywhere." });
    expect(byKey.get("project-rule")).toMatchObject({ state: "active", scope: "project", via: "scope" });
    expect(byKey.get("elsewhere")).toMatchObject({ state: "active", via: "mention" });
    // A draft or unknown key is "not active" and names nothing but its key: a draft title stays with the board.
    expect(byKey.get("still-draft")).toEqual({ state: "not_active", key: "still-draft" });
    expect(byKey.get("no-such-key")).toEqual({ state: "not_active", key: "no-such-key" });
    expect(JSON.stringify(res.body.policies)).not.toContain("SECRET-BODY-TEXT");
    expect(JSON.stringify(res.body.policies)).not.toContain("A draft title");
  });

  it("changes the digest when a policy changes and keeps it when nothing changed", async () => {
    const { companyId, create, createIssue, client } = await seedCompany("Digest");
    await create({ key: "company-rule", title: "Company rule" });
    const issue = await createIssue({ title: "Task" });
    const read = async () => (await client.get(`/api/issues/${issue.id}/heartbeat-context`)).body.policies.digest as string;

    const first = await read();
    expect(await read()).toBe(first);
    await companyPolicyService(db as Db).update(companyId, "company-rule", { summary: "Now with a summary." }, { userId: "board-user" });
    expect(await read()).not.toBe(first);
  });

  it("returns an empty index when no policy applies, and never another company's policy", async () => {
    const mine = await seedCompany("Mine");
    const theirs = await seedCompany("Theirs");
    await theirs.create({ key: "their-rule", title: "Their rule" });
    const issue = await mine.createIssue({ title: "Task", description: "Read [x](policy://their-rule)." });

    const res = await mine.client.get(`/api/issues/${issue.id}/heartbeat-context`);

    expect(res.status).toBe(200);
    // The same key in another company is unknown here, so the mention is "not active" and shows no title.
    expect(res.body.policies.entries).toEqual([{ state: "not_active", key: "their-rule" }]);
    expect(JSON.stringify(res.body)).not.toContain("Their rule");
  });
});
