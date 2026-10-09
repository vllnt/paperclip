import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  issueWorkProducts,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { issueGitLinkService } from "../services/issue-git-links.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("GitHub connection events link pull requests to tasks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-links-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(connectionEventDeliveries);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Co ${prefix}`, issuePrefix: prefix });
    await db.insert(toolApplications).values({
      id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`, transport: "mcp_remote",
      authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId, companyId, connectionId, kind: "user", subjectUserId: `owner-${randomUUID()}`, status: "active", isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected",
          installationIds: ["101"], installationOwnerLogins: ["acme"], repositories: [{ id: "203", fullName: "acme/app", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });
    return { companyId, grantId, prefix };
  }

  async function seedIssue(companyId: string, prefix: string, number: number) {
    const id = randomUUID();
    await db.insert(issues).values({
      id, companyId, title: `Task ${number}`, status: "todo", assigneeUserId: "user-1", identifier: `${prefix}-${number}`, issueNumber: number,
    });
    return id;
  }

  function leasedEvent(bindingIds: string[], overrides: Record<string, unknown> = {}, action = "opened") {
    return {
      id: `delivery-${randomUUID()}`,
      provider: "github" as const,
      event: "pull_request",
      action,
      installationId: "101",
      repositoryId: "203",
      createdAt: "2026-10-09T10:00:00.000Z",
      bindingIds,
      payload: {
        repository: "acme/app",
        number: 7,
        state: "open",
        merged: false,
        updatedAt: "2026-10-09T10:00:00.000Z",
        url: "https://github.com/acme/app/pull/7",
        headRef: "pap-12-fix-login",
        baseRef: "main",
        ...overrides,
      },
    };
  }

  function connectorFor(events: Array<ReturnType<typeof leasedEvent>>) {
    return {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${randomUUID()}`, events })),
      acknowledgeEvents: vi.fn(async () => events.length),
    } as unknown as PaperclipCloudConnector;
  }

  const enrich = async () => ({ headRepository: "acme/app", defaultBranch: "main", title: "Fix login", draft: false });

  it("links an opened pull request by branch name, then completes the task on merge", async () => {
    const { companyId, grantId, prefix } = await seedCompany("GLA");
    const issueId = await seedIssue(companyId, prefix, 12);
    const opened = leasedEvent([`${grantId}_101`], { headRef: "gla-12-fix-login" });
    const merged = leasedEvent([`${grantId}_101`], { headRef: "gla-12-fix-login", state: "closed", merged: true, updatedAt: "2026-10-09T11:00:00.000Z" }, "closed");
    const gitLinks = issueGitLinkService(db, { statusAutomationEnabled: async () => true, enrich });

    await githubConnectionEventService(db, { connector: connectorFor([opened]), gitLinks }).pollOnce();
    const afterOpen = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(afterOpen).toHaveLength(1);
    expect(afterOpen[0]).toMatchObject({ externalId: "acme/app#pull/7", status: "active", title: "Fix login" });
    expect(afterOpen[0]!.metadata).toMatchObject({ git: { linkedBy: "head_ref", source: "cloud_event", verified: true } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_review");

    await githubConnectionEventService(db, { connector: connectorFor([merged]), gitLinks }).pollOnce();
    expect((await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId)))[0]).toMatchObject({ status: "merged" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("done");
  });

  it("links but leaves status alone while the switch is off", async () => {
    const { companyId, grantId, prefix } = await seedCompany("GLB");
    const issueId = await seedIssue(companyId, prefix, 12);
    const gitLinks = issueGitLinkService(db, { statusAutomationEnabled: async () => false, enrich });

    await githubConnectionEventService(db, {
      connector: connectorFor([leasedEvent([`${grantId}_101`], { headRef: "glb-12-fix" })]),
      gitLinks,
    }).pollOnce();

    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("todo");
  });

  it("links only the company whose prefix matches when two companies share an installation", async () => {
    const a = await seedCompany("GLC");
    const b = await seedCompany("GLD");
    const issueA = await seedIssue(a.companyId, a.prefix, 12);
    const issueB = await seedIssue(b.companyId, b.prefix, 12);
    const gitLinks = issueGitLinkService(db, { statusAutomationEnabled: async () => false, enrich });

    await githubConnectionEventService(db, {
      connector: connectorFor([leasedEvent([`${a.grantId}_101`, `${b.grantId}_101`], { headRef: "glc-12-fix" })]),
      gitLinks,
    }).pollOnce();

    const all = await db.select().from(issueWorkProducts);
    expect(all.map((row) => row.issueId)).toEqual([issueA]);
    expect(all.every((row) => row.companyId === a.companyId)).toBe(true);
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueB))).toEqual([]);
  });

  it("still marks the delivery processed when linking fails", async () => {
    const { grantId } = await seedCompany("GLE");
    const event = leasedEvent([`${grantId}_101`]);
    const gitLinks = { recordPullRequestSignal: vi.fn(async () => { throw new Error("database hiccup"); }) };

    const result = await githubConnectionEventService(db, { connector: connectorFor([event]), gitLinks }).pollOnce();

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.providerDeliveryId, event.id));
    expect(receipt).toMatchObject({ status: "processed" });
    expect(gitLinks.recordPullRequestSignal).toHaveBeenCalledTimes(1);
  });

  it("does not link on a redelivered event", async () => {
    const { companyId, grantId, prefix } = await seedCompany("GLF");
    await seedIssue(companyId, prefix, 12);
    const event = leasedEvent([`${grantId}_101`], { headRef: "glf-12-fix" });
    const gitLinks = { recordPullRequestSignal: vi.fn(async () => ({ links: [], automation: [] })) };
    let clock = new Date("2026-10-09T10:00:05.000Z");
    const service = githubConnectionEventService(db, { connector: connectorFor([event]), gitLinks, now: () => clock });

    await service.pollOnce();
    clock = new Date(clock.getTime() + 60_000);
    const second = await service.pollOnce();
    expect(second).toMatchObject({ leased: 1, duplicate: 1, processed: 0 });

    expect(gitLinks.recordPullRequestSignal).toHaveBeenCalledTimes(1);
  });
});
