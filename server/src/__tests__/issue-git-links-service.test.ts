import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { gitLinkLockKey, issueGitLinkService, type PullRequestSignal } from "../services/issue-git-links.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { workProductService } from "../services/work-products.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue git link tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function randomPrefix(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `Q${Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join("")}`;
}

describeEmbeddedPostgres("issueGitLinkService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let automationOn = true;
  const service = () => issueGitLinkService(db, { statusAutomationEnabled: async () => automationOn });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-git-links-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    automationOn = true;
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = randomPrefix()) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Co ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    return { id, prefix };
  }

  async function seedIssue(
    company: { id: string; prefix: string },
    number: number,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: company.id,
      title: `Task ${number}`,
      status: "todo",
      assigneeUserId: "user-1",
      identifier: `${company.prefix}-${number}`,
      issueNumber: number,
      ...overrides,
    });
    return id;
  }

  function signal(prefix: string, overrides: Partial<PullRequestSignal> = {}): PullRequestSignal {
    return {
      provider: "github",
      repository: "acme/app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Fix login",
      body: null,
      headRef: `${prefix.toLowerCase()}-12-fix-login`,
      baseRef: "main",
      headRepository: "acme/app",
      defaultBranch: "main",
      state: "open",
      draft: false,
      merged: false,
      updatedAt: "2026-10-09T10:00:00.000Z",
      source: "plugin_poll",
      ...overrides,
    };
  }

  const issueRow = async (id: string) =>
    db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
  const productsFor = async (issueId: string) =>
    db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));

  describe("linking", () => {
    it("links a pull request to the task named in its branch and stores it as a work product", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.links).toHaveLength(1);
      expect(result.links[0]).toMatchObject({ issueId, created: true, changed: true });
      const [product] = await productsFor(issueId);
      expect(product).toMatchObject({
        companyId: company.id,
        type: "pull_request",
        provider: "github",
        externalId: "acme/app#pull/7",
        url: "https://github.com/acme/app/pull/7",
        status: "active",
      });
      expect(product!.metadata).toMatchObject({
        repo: "acme/app",
        number: 7,
        headRef: `${company.prefix.toLowerCase()}-12-fix-login`,
        baseRef: "main",
        state: "open",
        git: { linkedBy: "head_ref", closes: true, verified: true, source: "plugin_poll" },
      });
    });

    it("is idempotent for the same delivery and ignores a stale older update", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      const merged = signal(company.prefix, { state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" });

      await svc.recordPullRequestSignal(company.id, merged);
      const again = await svc.recordPullRequestSignal(company.id, merged);
      const stale = await svc.recordPullRequestSignal(company.id, signal(company.prefix, { updatedAt: "2026-10-09T09:00:00.000Z" }));

      expect(again.links[0]).toMatchObject({ created: false, changed: false });
      expect(stale.links[0]).toMatchObject({ created: false, changed: false, skipped: "stale" });
      const products = await productsFor(issueId);
      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({ status: "merged" });
      expect(products[0]!.metadata).toMatchObject({ state: "merged" });
    });

    it("never links a task in another company, even with the same number and a shared repository", async () => {
      const a = await seedCompany();
      const b = await seedCompany();
      const issueA = await seedIssue(a, 5);
      const issueB = await seedIssue(b, 5);

      const forB = await service().recordPullRequestSignal(b.id, signal("ZZZZZZ", { headRef: `${a.prefix.toLowerCase()}-5-fix` }));
      const forA = await service().recordPullRequestSignal(a.id, signal(a.prefix, { headRef: `${a.prefix.toLowerCase()}-5-fix` }));

      expect(forB.links).toEqual([]);
      expect(forA.links).toHaveLength(1);
      expect(await productsFor(issueB)).toEqual([]);
      expect((await productsFor(issueA)).every((p) => p.companyId === a.id)).toBe(true);
    });

    it("still refuses a task from another company whose identifier happens to carry this company's prefix", async () => {
      const a = await seedCompany();
      const b = await seedCompany();
      const strayId = randomUUID();
      await db.insert(issues).values({
        id: strayId,
        companyId: b.id,
        title: "Stray",
        status: "todo",
        assigneeUserId: "user-1",
        identifier: `${a.prefix}-9`,
        issueNumber: 9,
      });

      const result = await service().recordPullRequestSignal(a.id, signal(a.prefix, { headRef: `${a.prefix.toLowerCase()}-9-fix` }));

      expect(result.links).toEqual([]);
      expect(await db.select().from(issueWorkProducts)).toEqual([]);
      expect((await issueRow(strayId)).status).toBe("todo");
    });

    it("settles to one row when the same delivery arrives many times at once", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();

      await Promise.all(Array.from({ length: 6 }, () => svc.recordPullRequestSignal(company.id, signal(company.prefix))));

      expect(await productsFor(issueId)).toHaveLength(1);
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("makes a second writer wait while another holds the pull request's lock", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const lockKey = gitLinkLockKey(company.id, "acme/app#pull/7");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        await held;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      let finished = false;
      const pending = service()
        .recordPullRequestSignal(company.id, signal(company.prefix))
        .then((result) => { finished = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished).toBe(false);
      expect(await productsFor(issueId)).toHaveLength(0);

      release();
      await holder;
      await pending;
      expect(finished).toBe(true);
      expect(await productsFor(issueId)).toHaveLength(1);
    });

    it("rejects a manual link to a task in a different company and writes nothing", async () => {
      const a = await seedCompany();
      const b = await seedCompany();
      const issueB = await seedIssue(b, 1);

      await expect(
        service().recordPullRequestSignal(a.id, signal(a.prefix), { manualIssueId: issueB }),
      ).rejects.toThrow(/not found/i);
      expect(await db.select().from(issueWorkProducts)).toEqual([]);
    });

    async function seedWorkspace(company: { id: string }, issueId: string, branchName: string) {
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: company.id, name: "App" });
      await db.insert(executionWorkspaces).values({
        companyId: company.id,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "ws",
        branchName,
      });
    }

    it("links through the branch of an agent's execution workspace even when the name has no identifier", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 3);
      await seedWorkspace(company, issueId, "odd/custom-branch");

      const result = await service().recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "odd/custom-branch", headRepository: "acme/app" }),
      );

      expect(result.links[0]).toMatchObject({ issueId });
      const [product] = await productsFor(issueId);
      expect(product!.metadata).toMatchObject({ git: { linkedBy: "workspace_branch", verified: true, closes: true } });
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("never lets a fork pull request that copies a workspace branch name move the task", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 3);
      await seedWorkspace(company, issueId, "odd/custom-branch");
      const svc = service();

      const opened = await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "odd/custom-branch", headRepository: "mallory/app" }),
      );
      const merged = await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "odd/custom-branch", headRepository: "mallory/app", state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );

      const [product] = await productsFor(issueId);
      expect(product!.metadata).toMatchObject({ git: { linkedBy: "workspace_branch", verified: false } });
      expect(opened.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect(merged.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it("does not let a later event with an unknown head repository complete a task verified earlier", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();

      const opened = await svc.recordPullRequestSignal(company.id, signal(company.prefix));
      expect(opened.automation[0]).toMatchObject({ applied: { from: "todo", to: "in_review" } });

      const merged = await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRepository: null, state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z", source: "cloud_event" }),
      );

      expect(merged.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await productsFor(issueId))[0]!.metadata).toMatchObject({ git: { verified: false } });
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("does not complete a task through its workspace branch when the merge event no longer knows the head repository", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 3);
      await seedWorkspace(company, issueId, "agent/retry-fix");
      const svc = service();

      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { headRef: "agent/retry-fix", headRepository: "acme/app" }));
      expect((await issueRow(issueId)).status).toBe("in_review");

      const merged = await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "agent/retry-fix", headRepository: null, state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z", source: "cloud_event" }),
      );

      expect(merged.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("never verifies a pull request whose head repository is unknown or deleted from the start", async () => {
      const company = await seedCompany();
      const unknownId = await seedIssue(company, 12);
      const deletedId = await seedIssue(company, 13);

      const unknown = await service().recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRepository: null, state: "closed", merged: true }),
      );
      const deleted = await issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        enrich: async () => ({ headRepository: null, defaultBranch: "main" }),
      }).recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: `${company.prefix.toLowerCase()}-13-x`, number: 8, url: "https://github.com/acme/app/pull/8", headRepository: null, state: "closed", merged: true }),
      );

      expect(unknown.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect(deleted.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(unknownId)).status).toBe("todo");
      expect((await issueRow(deletedId)).status).toBe("todo");
    });

    it("treats a workspace branch match as unverified until the head repository is known", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 3);
      await seedWorkspace(company, issueId, "odd/custom-branch");
      const lean = signal(company.prefix, { headRef: "odd/custom-branch", headRepository: null, source: "cloud_event" });

      const unknown = await service().recordPullRequestSignal(company.id, lean);
      expect(unknown.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });

      const fork = await issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        enrich: async () => ({ headRepository: "mallory/app", defaultBranch: "main" }),
      }).recordPullRequestSignal(company.id, { ...lean, updatedAt: "2026-10-09T11:00:00.000Z" });
      expect(fork.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("todo");

      const same = await issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        enrich: async () => ({ headRepository: "acme/app", defaultBranch: "main" }),
      }).recordPullRequestSignal(company.id, { ...lean, updatedAt: "2026-10-09T12:00:00.000Z" });
      expect(same.automation[0]).toMatchObject({ applied: { from: "todo", to: "in_review" } });
    });

    it("applies closing words, refs words and skip tokens from the title and body", async () => {
      const company = await seedCompany();
      const closing = await seedIssue(company, 7);
      const refsOnly = await seedIssue(company, 8);
      const skipped = await seedIssue(company, 9);

      await service().recordPullRequestSignal(
        company.id,
        signal(company.prefix, {
          headRef: `${company.prefix.toLowerCase()}-9-spike`,
          body: `Fixes ${company.prefix}-7\nrefs ${company.prefix}-8\nskip ${company.prefix}-9`,
        }),
      );

      expect((await productsFor(closing))[0]!.metadata).toMatchObject({ git: { linkedBy: "keyword", closes: true } });
      expect((await productsFor(refsOnly))[0]!.metadata).toMatchObject({ git: { linkedBy: "refs", closes: false } });
      expect(await productsFor(skipped)).toEqual([]);
    });

    it("keeps the strongest evidence when a later signal carries no text", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 7);
      const svc = service();
      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "feature/x", body: `Fixes ${company.prefix}-7` }),
      );

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "feature/x", title: undefined, body: undefined, updatedAt: "2026-10-09T11:00:00.000Z", source: "cloud_event" }),
      );

      const [product] = await productsFor(issueId);
      expect(product!.metadata).toMatchObject({ git: { linkedBy: "keyword", closes: true, source: "cloud_event" } });
    });

    it("marks fork pull requests unverified and leaves status alone", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);

      const result = await service().recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRepository: "mallory/app" }),
      );

      expect((await productsFor(issueId))[0]!.metadata).toMatchObject({ git: { verified: false } });
      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it("fills in the head repository through the enrichment hook before deciding", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        enrich: async () => ({ headRepository: "acme/app", defaultBranch: "main", title: "Fix login (resolved)" }),
      });

      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { headRepository: null, defaultBranch: null, title: undefined }));

      const [product] = await productsFor(issueId);
      expect(product).toMatchObject({ title: "Fix login (resolved)" });
      expect(product!.metadata).toMatchObject({ git: { verified: true } });
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("adopts a pull request an agent already attached instead of adding a second row", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      await db.insert(issueWorkProducts).values({
        companyId: company.id,
        issueId,
        type: "pull_request",
        provider: "github",
        title: "Hand-attached",
        url: "https://github.com/acme/app/pull/7",
        status: "active",
        metadata: { repo: "acme/app", number: 7, reviewSummary: "kept" },
      });

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.links[0]).toMatchObject({ created: false, changed: true });
      const products = await productsFor(issueId);
      expect(products).toHaveLength(1);
      expect(products[0]!.metadata).toMatchObject({ reviewSummary: "kept", git: { closes: true } });
    });

    it("keeps an unlinked pull request unlinked until a person links it again", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      const first = await svc.recordPullRequestSignal(company.id, signal(company.prefix));
      const productId = first.links[0]!.workProductId;

      expect(await svc.unlinkPullRequest(issueId, company.id, productId)).toBe("unlinked");
      expect(await svc.unlinkPullRequest(issueId, company.id, productId)).toBe("already_unlinked");
      expect(await svc.unlinkPullRequest(issueId, company.id, randomUUID())).toBe("not_found");
      const auto = await svc.recordPullRequestSignal(company.id, signal(company.prefix, { updatedAt: "2026-10-09T11:00:00.000Z" }));
      expect(auto.links[0]).toMatchObject({ skipped: "suppressed" });
      expect((await svc.getView(issueId, company.id)).pullRequests).toEqual([]);
      expect((await workProductService(db).listForIssue(issueId)).filter((p) => p.type === "pull_request")).toEqual([]);

      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { updatedAt: "2026-10-09T12:00:00.000Z", source: "manual" }), { manualIssueId: issueId });
      expect((await svc.getView(issueId, company.id)).pullRequests).toHaveLength(1);
      expect((await workProductService(db).listForIssue(issueId)).filter((p) => p.type === "pull_request")).toHaveLength(1);
    });
  });

  describe("status automation", () => {
    it("moves a todo task to in_review when a ready pull request opens", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.automation[0]).toMatchObject({ issueId, applied: { from: "todo", to: "in_review" } });
      expect((await issueRow(issueId)).status).toBe("in_review");
      const log = await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "issue.git_status_automated")));
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actorType: "system", entityId: issueId });
      expect(log[0]!.details).toMatchObject({ status: "in_review", _previous: { status: "todo" } });
    });

    it("moves to in_progress for a draft pull request", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      await service().recordPullRequestSignal(company.id, signal(company.prefix, { draft: true }));
      expect((await issueRow(issueId)).status).toBe("in_progress");
    });

    it("completes the task when the pull request merges into the default branch", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      await svc.recordPullRequestSignal(company.id, signal(company.prefix));

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );

      const row = await issueRow(issueId);
      expect(row.status).toBe("done");
      expect(row.completedAt).not.toBeNull();
    });

    it("does not complete the task when a stacked pull request merges into another branch", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { baseRef: "feat/parent" }));

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { baseRef: "feat/parent", state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );

      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("sends the task back to where it was when the only pull request closes unmerged", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12, { status: "in_progress" });
      const svc = service();
      await svc.recordPullRequestSignal(company.id, signal(company.prefix));
      expect((await issueRow(issueId)).status).toBe("in_review");

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { state: "closed", merged: false, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );

      expect((await issueRow(issueId)).status).toBe("in_progress");
    });

    it("waits for every closing pull request before completing", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { number: 7 }));
      await svc.recordPullRequestSignal(company.id, signal(company.prefix, { number: 8, url: "https://github.com/acme/app/pull/8" }));

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { number: 7, state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );
      expect((await issueRow(issueId)).status).toBe("in_review");

      await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { number: 8, url: "https://github.com/acme/app/pull/8", state: "closed", merged: true, updatedAt: "2026-10-09T12:30:00.000Z" }),
      );
      expect((await issueRow(issueId)).status).toBe("done");
    });

    it("stops touching a task once someone changed its status by hand", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const svc = service();
      await svc.recordPullRequestSignal(company.id, signal(company.prefix));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));

      const result = await svc.recordPullRequestSignal(
        company.id,
        signal(company.prefix, { state: "closed", merged: true, updatedAt: "2026-10-09T12:00:00.000Z" }),
      );

      expect((await issueRow(issueId)).status).toBe("in_progress");
      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "manual_change" });
    });

    it("follows the stored instance setting when no switch is injected", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      const settings = instanceSettingsService(db);
      const defaultService = issueGitLinkService(db);

      try {
        await defaultService.recordPullRequestSignal(company.id, signal(company.prefix));
        expect((await issueRow(issueId)).status).toBe("todo");

        await settings.updateGeneral({ gitStatusAutomation: true });
        await defaultService.recordPullRequestSignal(company.id, signal(company.prefix, { updatedAt: "2026-10-09T11:00:00.000Z" }));
        expect((await issueRow(issueId)).status).toBe("in_review");
        expect((await defaultService.getView(issueId, company.id)).statusAutomation.enabled).toBe(true);
      } finally {
        await settings.updateGeneral({ gitStatusAutomation: false });
      }
    });

    it("links but never changes status while the switch is off", async () => {
      automationOn = false;
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.links).toHaveLength(1);
      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "disabled" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it.each([
      ["done", { status: "done" }],
      ["cancelled", { status: "cancelled" }],
      ["blocked", { status: "blocked" }],
      ["hidden", { hiddenAt: new Date() }],
      ["origin", { originKind: "routine_execution", originId: "r1" }],
      ["unassigned", { assigneeUserId: null }],
    ] as const)("leaves a %s task alone", async (_label, overrides) => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12, overrides as Partial<typeof issues.$inferInsert>);
      const before = (await issueRow(issueId)).status;

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.links).toHaveLength(1);
      expect(result.automation[0]!.applied).toBeNull();
      expect((await issueRow(issueId)).status).toBe(before);
    });

    it("defers while an agent run holds the task", async () => {
      const company = await seedCompany();
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId, companyId: company.id, name: "Coder", role: "engineer", status: "running",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId, invocationSource: "assignment", status: "running", contextSnapshot: {} });
      const issueId = await seedIssue(company, 12, { status: "in_progress", assigneeUserId: null, assigneeAgentId: agentId, executionRunId: runId });

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "active_run" });
      expect((await issueRow(issueId)).status).toBe("in_progress");
    });

    it("defers while a confirmation is waiting on a person", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 12);
      await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId, kind: "request_confirmation", status: "pending", payload: {} as never });

      const result = await service().recordPullRequestSignal(company.id, signal(company.prefix));

      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "pending_confirmation" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it("never overrides an execution policy or a review policy", async () => {
      const company = await seedCompany();
      const withPolicy = await seedIssue(company, 12, { executionPolicy: { stages: [] } as never });
      const withReview = await seedIssue(company, 13, { reviewPolicy: "human_only" });

      const a = await service().recordPullRequestSignal(company.id, signal(company.prefix));
      const b = await service().recordPullRequestSignal(company.id, signal(company.prefix, { headRef: `${company.prefix.toLowerCase()}-13-x`, number: 9, url: "https://github.com/acme/app/pull/9" }));

      expect(a.automation[0]).toMatchObject({ deferred: "gated" });
      expect(b.automation[0]).toMatchObject({ deferred: "gated" });
      expect((await issueRow(withPolicy)).status).toBe("todo");
      expect((await issueRow(withReview)).status).toBe("todo");
    });
  });

  describe("linking by reference", () => {
    const resolved = (overrides: Record<string, unknown> = {}) => async () => ({
      state: "open" as const,
      headRef: "feature/unrelated",
      headSha: "abc",
      workProductState: "open" as const,
      draft: false,
      baseRef: "main",
      headRepository: "acme/app",
      defaultBranch: "main",
      ...overrides,
    });

    it("reads the pull request from GitHub and links it, closing by default", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 4);
      const svc = issueGitLinkService(db, { statusAutomationEnabled: async () => true, resolvePullRequestDetails: resolved() });

      const result = await svc.linkPullRequest(issueId, company.id, { repository: "Acme/App", number: 7 }, "agent");

      expect(result.links[0]).toMatchObject({ issueId, created: true });
      const [product] = await productsFor(issueId);
      expect(product).toMatchObject({ externalId: "acme/app#pull/7", url: "https://github.com/acme/app/pull/7" });
      expect(product!.metadata).toMatchObject({ headRef: "feature/unrelated", baseRef: "main", state: "open", git: { linkedBy: "manual", closes: true, verified: true } });
      expect((await issueRow(issueId)).status).toBe("in_review");
    });

    it("links a merged pull request as merged", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 4);
      const svc = issueGitLinkService(db, { statusAutomationEnabled: async () => false, resolvePullRequestDetails: resolved({ workProductState: "merged", state: "open" }) });

      await svc.linkPullRequest(issueId, company.id, { repository: "acme/app", number: 7, closes: false }, "manual");

      const [product] = await productsFor(issueId);
      expect(product).toMatchObject({ status: "merged" });
      expect(product!.metadata).toMatchObject({ state: "merged", git: { closes: false } });
    });

    it("still links when GitHub cannot be read, but treats the state as unconfirmed", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 4);
      const svc = issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        resolvePullRequestDetails: async () => ({ state: "unknown" as const, headRef: null, headSha: null }),
      });

      const result = await svc.linkPullRequest(issueId, company.id, { repository: "acme/app", number: 7 }, "agent");

      expect(result.links).toHaveLength(1);
      expect((await productsFor(issueId))[0]!.metadata).toMatchObject({ git: { verified: false } });
      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it("links a fork pull request by hand but never lets it move the task", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 4);
      const svc = issueGitLinkService(db, {
        statusAutomationEnabled: async () => true,
        resolvePullRequestDetails: resolved({ headRepository: "mallory/app", defaultBranch: "main" }),
      });

      const result = await svc.linkPullRequest(issueId, company.id, { repository: "acme/app", number: 7 }, "agent");

      expect(result.links[0]).toMatchObject({ issueId, created: true });
      expect((await productsFor(issueId))[0]!.metadata).toMatchObject({ git: { linkedBy: "manual", verified: false } });
      expect(result.automation[0]).toMatchObject({ applied: null, deferred: "unverified" });
      expect((await issueRow(issueId)).status).toBe("todo");
    });

    it("refuses a task from another company", async () => {
      const a = await seedCompany();
      const b = await seedCompany();
      const issueB = await seedIssue(b, 1);
      const svc = issueGitLinkService(db, { statusAutomationEnabled: async () => true, resolvePullRequestDetails: resolved() });

      await expect(svc.linkPullRequest(issueB, a.id, { repository: "acme/app", number: 7 }, "manual")).rejects.toThrow(/not found/i);
      expect(await db.select().from(issueWorkProducts)).toEqual([]);
    });
  });

  describe("manual linking", () => {
    it("links a pull request to a chosen task, closing by default", async () => {
      const company = await seedCompany();
      const issueId = await seedIssue(company, 4);

      const result = await service().recordPullRequestSignal(
        company.id,
        signal(company.prefix, { headRef: "totally/unrelated", source: "manual" }),
        { manualIssueId: issueId },
      );

      expect(result.links[0]).toMatchObject({ issueId, created: true });
      expect((await productsFor(issueId))[0]!.metadata).toMatchObject({ git: { linkedBy: "manual", closes: true, verified: true } });
    });
  });
});
