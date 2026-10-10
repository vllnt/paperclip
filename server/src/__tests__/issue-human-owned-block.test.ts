import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { attentionService } from "../services/attention.js";
import { issueService } from "../services/issues.js";
import { HUMAN_OWNED_BLOCK_MESSAGE, ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping human-owned block tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const BOARD_BLOCK: IssueUnblockDescriptor = { owner: "board", action: "Approve the deploy" };
const BLOCKED_AT = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 60_000);

function appFor(db: Db, actor: Express.Request["actor"]) {
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

describeEmbeddedPostgres("blocks that wait for a human", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-human-owned-block-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    descriptor: IssueUnblockDescriptor | null;
    blockedTransitionAt: Date | null;
  }) {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db
      .insert(companies)
      .values({
        name: `Block ${nonce}`,
        issuePrefix: `HB${nonce.slice(0, 4).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: `Agent ${nonce}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        title: "Waiting on a human",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agent!.id,
        responsibleUserId: "board-user",
        unblockDescriptor: input.descriptor,
        blockedTransitionAt: input.blockedTransitionAt,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company!.id,
        agentId: agent!.id,
        status: "running",
        contextSnapshot: { issueId: issue!.id },
      })
      .returning();
    return { company: company!, agent: agent!, run: run!, issue: issue! };
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  function agentActor(fixture: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: fixture.run.id,
      source: "agent_jwt",
    };
  }

  function boardActor(fixture: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [fixture.company.id],
      memberships: [{ companyId: fixture.company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  async function refusal(attempt: Promise<unknown>) {
    return attempt.then(
      () => null,
      (error: unknown) => error,
    );
  }

  describe("the issue service", () => {
    const refusedChanges: Array<[string, Record<string, unknown>]> = [
      ["moves the issue to todo", { status: "todo" }],
      ["moves the issue to in progress", { status: "in_progress" }],
      ["clears the descriptor", { unblockDescriptor: null }],
      ["takes the block back", { unblockDescriptor: { owner: { agentId: randomUUID() }, action: "Never mind" } }],
      ["rewrites the action", { unblockDescriptor: { owner: "board", action: "A different action" } }],
    ];

    it.each(refusedChanges)("refuses an agent that %s on a board-owned block and changes nothing", async (_label, change) => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });
      const before = await readIssue(fixture.issue.id);

      const failure = await refusal(
        issueService(db).update(fixture.issue.id, { ...change, actorAgentId: fixture.agent.id }),
      );

      expect(failure).toMatchObject({ status: 403, message: HUMAN_OWNED_BLOCK_MESSAGE });
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(after.blockedTransitionAt).toEqual(before.blockedTransitionAt);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it("refuses an agent that leaves a block owned by a company user", async () => {
      const descriptor: IssueUnblockDescriptor = { owner: { userId: "board-user" }, action: "Sign the form" };
      const fixture = await seed({ descriptor, blockedTransitionAt: BLOCKED_AT });

      const failure = await refusal(
        issueService(db).update(fixture.issue.id, { status: "todo", actorAgentId: fixture.agent.id }),
      );

      expect(failure).toMatchObject({ status: 403 });
      expect((await readIssue(fixture.issue.id)).status).toBe("blocked");
    });

    it("lets an agent change other fields, or send the same descriptor again, without leaving the block", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      await issueService(db).update(fixture.issue.id, {
        title: "Owned issue (waiting on deploy approval)",
        unblockDescriptor: BOARD_BLOCK,
        actorAgentId: fixture.agent.id,
      });

      const after = await readIssue(fixture.issue.id);
      expect(after.title).toBe("Owned issue (waiting on deploy approval)");
      expect(after.status).toBe("blocked");
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
    });

    it("lets a board user and a system caller unblock the issue", async () => {
      const byUser = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });
      const bySystem = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      await issueService(db).update(byUser.issue.id, { status: "todo", actorUserId: "board-user" });
      await issueService(db).update(bySystem.issue.id, { status: "todo" });

      for (const fixture of [byUser, bySystem]) {
        const after = await readIssue(fixture.issue.id);
        expect(after.status).toBe("todo");
        expect(after.unblockDescriptor).toBeNull();
      }
    });

    it("stamps a new transition time when an agent hands a legacy blocked issue to the board, and the board sees it once", async () => {
      const legacyOwners: Array<IssueUnblockDescriptor | null> = [
        null,
        { owner: { agentId: randomUUID() }, action: "Wait for the build" },
      ];
      for (const descriptor of legacyOwners) {
        const fixture = await seed({ descriptor, blockedTransitionAt: null });
        const feedBefore = await attentionService(db).list(fixture.company.id, { userId: "board-user" });
        expect(feedBefore.items.filter((item) => item.dedupKey.startsWith(`blocked-owner:${fixture.issue.id}`))).toHaveLength(0);

        await issueService(db).update(fixture.issue.id, {
          unblockDescriptor: BOARD_BLOCK,
          actorAgentId: fixture.agent.id,
        });

        const handedOver = await readIssue(fixture.issue.id);
        expect(handedOver.status).toBe("blocked");
        expect(handedOver.unblockDescriptor).toEqual(BOARD_BLOCK);
        expect(handedOver.blockedTransitionAt).not.toBeNull();
        expect(handedOver.blockedTransitionAt!.getTime()).toBeGreaterThanOrEqual(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime());

        const feed = await attentionService(db).list(fixture.company.id, { userId: "board-user" });
        const items = feed.items.filter((item) => item.dedupKey.startsWith(`blocked-owner:${fixture.issue.id}`));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ sourceKind: "blocker_attention", whyNow: BOARD_BLOCK.action });

        const stranded = await refusal(
          issueService(db).update(fixture.issue.id, { status: "todo", actorAgentId: fixture.agent.id }),
        );
        expect(stranded).toMatchObject({ status: 403 });

        await issueService(db).update(fixture.issue.id, { status: "todo", actorUserId: "board-user" });
        const feedAfter = await attentionService(db).list(fixture.company.id, { userId: "board-user" });
        expect(feedAfter.items.filter((item) => item.dedupKey.startsWith(`blocked-owner:${fixture.issue.id}`))).toHaveLength(0);
      }
    });

    it("keeps the transition time when the owner does not change, so the board item stays one", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      await issueService(db).update(fixture.issue.id, {
        unblockDescriptor: BOARD_BLOCK,
        title: "Retitled",
        actorAgentId: fixture.agent.id,
      });

      expect((await readIssue(fixture.issue.id)).blockedTransitionAt).toEqual(BLOCKED_AT);
      const feed = await attentionService(db).list(fixture.company.id, { userId: "board-user" });
      expect(feed.items.filter((item) => item.dedupKey.startsWith(`blocked-owner:${fixture.issue.id}`))).toHaveLength(1);
    });
  });

  describe("the issue routes", () => {
    it.each([
      ["resume", { resume: true }],
      ["reopen", { reopen: true }],
    ])("refuses a comment with %s from the assigned agent, posts nothing and leaves the block", async (_label, flag) => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      const res = await request(appFor(db, agentActor(fixture)))
        .post(`/api/issues/${fixture.issue.id}/comments`)
        .send({ body: "Continuing anyway", ...flag });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(HUMAN_OWNED_BLOCK_MESSAGE);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
      await expect(db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).resolves.toHaveLength(0);
    });

    it("lets a board user resume the issue with a comment", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      const res = await request(appFor(db, boardActor(fixture)))
        .post(`/api/issues/${fixture.issue.id}/comments`)
        .send({ body: "Approved, go ahead", resume: true });

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("todo");
      expect(after.unblockDescriptor).toBeNull();
    });

    it("still lets the assigned agent post a plain comment on a board-owned block", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      const res = await request(appFor(db, agentActor(fixture)))
        .post(`/api/issues/${fixture.issue.id}/comments`)
        .send({ body: "Still waiting for the approval" });

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
    });

    it("refuses a PATCH from the assigned agent that leaves the block, with the same 403", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      const res = await request(appFor(db, agentActor(fixture)))
        .patch(`/api/issues/${fixture.issue.id}`)
        .send({ status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(HUMAN_OWNED_BLOCK_MESSAGE);
      expect((await readIssue(fixture.issue.id)).status).toBe("blocked");
    });
  });
});
