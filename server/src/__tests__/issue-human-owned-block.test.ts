import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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
import { prepareConversationTurn, settleConversationTurn } from "../services/agent-conversations.js";
import { shouldAutoCheckoutIssueForWake } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import {
  checkoutKeepsHumanOwnedBlock,
  HEARTBEAT_CHECKOUT_ACTOR,
  HUMAN_OWNED_BLOCK_MESSAGE,
  isHumanOwnedBlock,
  notHumanOwnedBlockCondition,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

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
  describe("checkout", () => {
    const CHECKOUT_STATUSES = ["todo", "backlog", "blocked"];
    const USER_BLOCK: IssueUnblockDescriptor = { owner: { userId: "board-user" }, action: "Sign the form" };

    async function postCheckout(fixture: Awaited<ReturnType<typeof seed>>, actor: Express.Request["actor"]) {
      return request(appFor(db, actor))
        .post(`/api/issues/${fixture.issue.id}/checkout`)
        .send({ agentId: fixture.agent.id, expectedStatuses: CHECKOUT_STATUSES });
    }

    async function expectUntouched(fixture: Awaited<ReturnType<typeof seed>>, descriptor: IssueUnblockDescriptor) {
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(descriptor);
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
      expect(after.checkoutRunId).toBeNull();
      expect(after.executionRunId).toBeNull();
    }

    it.each([
      ["the board", BOARD_BLOCK],
      ["a person", USER_BLOCK],
    ])("refuses the assigned agent a checkout of a block owned by %s, with 403, and changes nothing", async (_label, descriptor) => {
      const fixture = await seed({ descriptor, blockedTransitionAt: BLOCKED_AT });

      const res = await postCheckout(fixture, agentActor(fixture));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(HUMAN_OWNED_BLOCK_MESSAGE);
      await expectUntouched(fixture, descriptor);
    });

    it("leaves the issue blocked when the agent then releases it, so it never reaches todo with the descriptor on it", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });
      const actor = agentActor(fixture);

      const checkout = await postCheckout(fixture, actor);
      const release = await request(appFor(db, actor)).post(`/api/issues/${fixture.issue.id}/release`).send({});

      expect(checkout.status, JSON.stringify(checkout.body)).toBe(403);
      expect(release.status, JSON.stringify(release.body)).toBeLessThan(500);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
    });

    it("lets the assigned agent check out a block that it owns itself", async () => {
      const fixture = await seed({ descriptor: null, blockedTransitionAt: BLOCKED_AT });
      const own: IssueUnblockDescriptor = { owner: { agentId: fixture.agent.id }, action: "Wait for the build" };
      await db.update(issues).set({ unblockDescriptor: own }).where(eq(issues.id, fixture.issue.id));

      const res = await postCheckout(fixture, agentActor(fixture));

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await readIssue(fixture.issue.id)).status).toBe("in_progress");
    });

    it("refuses at the service when the caller is named as an agent, with 403, and writes nothing", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

      const failure = await refusal(
        issueService(db).checkout(fixture.issue.id, fixture.agent.id, CHECKOUT_STATUSES, fixture.run.id, {
          kind: "agent",
          agentId: fixture.agent.id,
        }),
      );

      expect(failure).toMatchObject({ status: 403, message: HUMAN_OWNED_BLOCK_MESSAGE });
      await expectUntouched(fixture, BOARD_BLOCK);
    });

    it("decides the rule from the kind of actor: an agent is held to it, the board and the system are not", () => {
      expect(checkoutKeepsHumanOwnedBlock({ kind: "agent", agentId: "agent-1" })).toBe(true);
      expect(checkoutKeepsHumanOwnedBlock({ kind: "board", userId: "board-user" })).toBe(false);
      expect(checkoutKeepsHumanOwnedBlock({ kind: "board", userId: null })).toBe(false);
      expect(checkoutKeepsHumanOwnedBlock(HEARTBEAT_CHECKOUT_ACTOR)).toBe(false);
    });

    it("does not skip the rule when a JavaScript caller leaves the actor out: the call fails and writes nothing", async () => {
      const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });
      const checkout = issueService(db).checkout;

      const failure = await refusal(
        Reflect.apply(checkout, undefined, [fixture.issue.id, fixture.agent.id, CHECKOUT_STATUSES, fixture.run.id]),
      );

      expect(failure).toBeInstanceOf(Error);
      await expectUntouched(fixture, BOARD_BLOCK);
    });

    // The one exemption: the named system actor. `issueService.checkout` documents it.
    describe("the system checkout", () => {
      it("lets a board user check out a block that the board owns", async () => {
        const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

        const res = await postCheckout(fixture, boardActor(fixture));

        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        expect((await readIssue(fixture.issue.id)).status).toBe("in_progress");
      });

      it("documents today's heartbeat path: it passes HEARTBEAT_CHECKOUT_ACTOR, so it still moves a board-owned block to in_progress", async () => {
        const fixture = await seed({ descriptor: BOARD_BLOCK, blockedTransitionAt: BLOCKED_AT });

        expect(
          shouldAutoCheckoutIssueForWake({
            contextSnapshot: { wakeReason: "issue_assigned" },
            issueStatus: "blocked",
            issueAssigneeAgentId: fixture.agent.id,
            issueExecutionState: null,
            isDependencyReady: true,
            agentId: fixture.agent.id,
          }),
        ).toBe(true);

        const checkedOut = await issueService(db).checkout(
          fixture.issue.id,
          fixture.agent.id,
          ["todo", "backlog", "blocked"],
          fixture.run.id,
          HEARTBEAT_CHECKOUT_ACTOR,
        );

        expect(checkedOut.status).toBe("in_progress");
        expect((await readIssue(fixture.issue.id)).status).toBe("in_progress");
      });
    });

    it("has a SQL condition that matches the TypeScript rule for every status and owner", async () => {
      const fixture = await seed({ descriptor: null, blockedTransitionAt: null });
      const descriptors: Array<IssueUnblockDescriptor | null> = [
        null,
        BOARD_BLOCK,
        USER_BLOCK,
        { owner: { agentId: fixture.agent.id }, action: "Wait" },
      ];
      for (const status of ["blocked", "todo", "in_progress"]) {
        for (const descriptor of descriptors) {
          await db.insert(issues).values({
            companyId: fixture.company.id,
            title: `${status} ${descriptor ? JSON.stringify(descriptor.owner) : "none"}`,
            status,
            priority: "medium",
            unblockDescriptor: descriptor,
          });
        }
      }

      const rows = await db.select().from(issues).where(eq(issues.companyId, fixture.company.id));
      const allowed = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, fixture.company.id), notHumanOwnedBlockCondition(issues)));

      expect(rows.length).toBeGreaterThanOrEqual(13);
      expect(new Set(allowed.map((row) => row.id))).toEqual(
        new Set(rows.filter((row) => !isHumanOwnedBlock(row)).map((row) => row.id)),
      );
      expect(rows.filter((row) => isHumanOwnedBlock(row)).length).toBe(2);
    });
  });

  describe("a conversation turn", () => {
    async function conversationFixture(input: { descriptor: IssueUnblockDescriptor | null; status?: string }) {
      const fixture = await seed({ descriptor: input.descriptor, blockedTransitionAt: BLOCKED_AT });
      await db
        .update(issues)
        .set({
          status: input.status ?? "blocked",
          conversationAgentId: fixture.agent.id,
          conversationUserId: "board-user",
          conversationState: "waiting",
        })
        .where(eq(issues.id, fixture.issue.id));
      return fixture;
    }

    async function startTurn(
      fixture: Awaited<ReturnType<typeof seed>>,
      author: { authorUserId: string } | { authorAgentId: string },
    ) {
      const [comment] = await db
        .insert(issueComments)
        .values({ companyId: fixture.company.id, issueId: fixture.issue.id, body: "Next message", ...author })
        .returning();
      const run = { ...fixture.run, contextSnapshot: { issueId: fixture.issue.id, wakeCommentId: comment!.id } };
      return prepareConversationTurn(db, run);
    }

    it("keeps a board-owned block when a turn that the agent started begins, and still runs the turn", async () => {
      const fixture = await conversationFixture({ descriptor: BOARD_BLOCK });

      const turn = await startTurn(fixture, { authorAgentId: fixture.agent.id });

      expect(turn.conversation).toBe(true);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
      expect(after.conversationState).toBe("active");
    });

    it("moves the issue to in progress when a board user's message started the turn", async () => {
      const fixture = await conversationFixture({ descriptor: BOARD_BLOCK });

      const turn = await startTurn(fixture, { authorUserId: "board-user" });

      expect(turn.conversation).toBe(true);
      const after = await readIssue(fixture.issue.id);
      expect(after.status).toBe("in_progress");
      expect(after.conversationState).toBe("active");
    });

    it("moves a block that the agent owns itself to in progress, as before", async () => {
      const fixture = await conversationFixture({ descriptor: null });
      await db
        .update(issues)
        .set({ unblockDescriptor: { owner: { agentId: fixture.agent.id }, action: "Wait" } })
        .where(eq(issues.id, fixture.issue.id));

      await startTurn(fixture, { authorAgentId: fixture.agent.id });

      expect((await readIssue(fixture.issue.id)).status).toBe("in_progress");
    });

    it("moves a conversation that is not blocked to in progress, as before", async () => {
      const fixture = await conversationFixture({ descriptor: null, status: "in_review" });

      await startTurn(fixture, { authorAgentId: fixture.agent.id });

      expect((await readIssue(fixture.issue.id)).status).toBe("in_progress");
    });

    describe("when it settles", () => {
      const PERSON_BLOCK: IssueUnblockDescriptor = { owner: { userId: "board-user" }, action: "Sign the form" };

      /** A conversation issue whose last turn succeeded with a reply, as the reviewer's probe seeded it. */
      async function settledTurn(input: { descriptor: IssueUnblockDescriptor | null; status?: string }) {
        const fixture = await conversationFixture(input);
        await db.update(issues).set({ conversationState: "active" }).where(eq(issues.id, fixture.issue.id));
        const [run] = await db
          .insert(heartbeatRuns)
          .values({
            companyId: fixture.company.id,
            agentId: fixture.agent.id,
            status: "succeeded",
            contextSnapshot: { issueId: fixture.issue.id, conversationSessionGeneration: 0 },
          })
          .returning();
        const [reply] = await db
          .insert(issueComments)
          .values({
            companyId: fixture.company.id,
            issueId: fixture.issue.id,
            body: "The agent's reply",
            createdByRunId: run!.id,
            authorAgentId: fixture.agent.id,
          })
          .returning();
        return { fixture, run: run!, reply: reply! };
      }

      it.each([
        ["the board", BOARD_BLOCK],
        ["a person", PERSON_BLOCK],
      ])("leaves a block owned by %s blocked with its descriptor, and keeps the reply", async (_label, descriptor) => {
        const { fixture, run, reply } = await settledTurn({ descriptor });
        const before = await readIssue(fixture.issue.id);

        const settled = await settleConversationTurn(db, run);

        expect(settled).toBe(true);
        const after = await readIssue(fixture.issue.id);
        expect(after.status).toBe("blocked");
        expect(after.unblockDescriptor).toEqual(descriptor);
        expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
        expect(after.statusVersion).toBe(before.statusVersion);
        expect(after.conversationState).toBe("waiting");
        await expect(db.select().from(issueComments).where(eq(issueComments.id, reply.id))).resolves.toHaveLength(1);
      });

      it("leaves a block owned by the board blocked when a newer message is waiting, and keeps the turn active", async () => {
        const { fixture, run } = await settledTurn({ descriptor: BOARD_BLOCK });
        const [wake] = await db
          .insert(issueComments)
          .values({
            companyId: fixture.company.id,
            issueId: fixture.issue.id,
            body: "The message that started the turn",
            authorUserId: "board-user",
            createdAt: new Date(Date.now() - 10_000),
          })
          .returning();
        await db.insert(issueComments).values({
          companyId: fixture.company.id,
          issueId: fixture.issue.id,
          body: "A message that arrived during the reply",
          authorUserId: "board-user",
          createdAt: new Date(Date.now() + 5_000),
        });
        const [current] = await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: { issueId: fixture.issue.id, conversationSessionGeneration: 0, wakeCommentId: wake!.id },
          })
          .where(eq(heartbeatRuns.id, run.id))
          .returning();

        await settleConversationTurn(db, current!);

        const after = await readIssue(fixture.issue.id);
        expect(after.status).toBe("blocked");
        expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
        expect(after.conversationState).toBe("active");
      });

      it("moves a block that the agent owns itself to in review, as before", async () => {
        const { fixture, run } = await settledTurn({ descriptor: null });
        await db
          .update(issues)
          .set({ unblockDescriptor: { owner: { agentId: fixture.agent.id }, action: "Wait" } })
          .where(eq(issues.id, fixture.issue.id));

        await settleConversationTurn(db, run);

        const after = await readIssue(fixture.issue.id);
        expect(after.status).toBe("in_review");
        expect(after.conversationState).toBe("waiting");
        expect(Number(after.statusVersion)).toBe(1);
      });

      it("moves a conversation that is not blocked to in review, as before", async () => {
        const { fixture, run } = await settledTurn({ descriptor: null, status: "in_progress" });

        await settleConversationTurn(db, run);

        expect((await readIssue(fixture.issue.id)).status).toBe("in_review");
      });
    });
  });
});
