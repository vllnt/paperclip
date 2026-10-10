import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { runWithPluginHostCallAgent } from "../services/plugin-host-call-actor.js";
import { HUMAN_OWNED_BLOCK_MESSAGE, ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin issue update block tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const BOARD_BLOCK: IssueUnblockDescriptor = { owner: "board", action: "Approve the deploy" };
const BLOCKED_AT = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 60_000);

const EVENT_BUS_STUB = {
  forPlugin() {
    return { emit: async () => {}, subscribe: () => {} };
  },
} as never;

describeEmbeddedPostgres("a plugin issues.update on a block that waits for a human", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issue-update-block-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(descriptor: IssueUnblockDescriptor | null) {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db
      .insert(companies)
      .values({ name: `Plugin ${nonce}`, issuePrefix: `PB${nonce.slice(0, 4).toUpperCase()}` })
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
        unblockDescriptor: descriptor,
        blockedTransitionAt: BLOCKED_AT,
      })
      .returning();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", EVENT_BUS_STUB);
    const asAgent = <T>(fn: () => T) =>
      runWithPluginHostCallAgent({ agentId: agent!.id, runId: null, companyId: company!.id }, fn);
    return { companyId: company!.id, agent: agent!, issue: issue!, services, asAgent };
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  async function failureOf(attempt: Promise<unknown>) {
    return attempt.then(
      () => null,
      (error: unknown) => error,
    );
  }

  async function expectBlockKept(fixture: Awaited<ReturnType<typeof seed>>, before: Awaited<ReturnType<typeof readIssue>>) {
    const after = await readIssue(fixture.issue.id);
    expect(after.status).toBe("blocked");
    expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
    expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
    expect(after.updatedAt).toEqual(before.updatedAt);
  }

  it.each([
    ["moves the issue to todo", { status: "todo" }],
    ["clears the descriptor", { unblockDescriptor: null }],
    ["gives the block to an agent", { unblockDescriptor: { owner: { agentId: randomUUID() }, action: "Take over" } }],
  ])("refuses a call from an agent that %s, though the worker sent no actor field", async (_label, patch) => {
    const fixture = await seed(BOARD_BLOCK);
    const before = await readIssue(fixture.issue.id);

    const failure = await failureOf(
      fixture.asAgent(() => fixture.services.issues.update({ issueId: fixture.issue.id, companyId: fixture.companyId, patch })),
    );

    expect(failure).toMatchObject({ status: 403, message: HUMAN_OWNED_BLOCK_MESSAGE });
    await expectBlockKept(fixture, before);
  });

  it("keeps the agent behind the call as the actor when the worker names a user or another agent", async () => {
    const fixture = await seed(BOARD_BLOCK);
    const before = await readIssue(fixture.issue.id);

    for (const patch of [
      { status: "todo", actorUserId: "board-user" },
      { status: "todo", actorAgentId: randomUUID() },
      { status: "todo", actorUserId: "board-user", actorAgentId: null },
    ]) {
      const failure = await failureOf(
        fixture.asAgent(() => fixture.services.issues.update({ issueId: fixture.issue.id, companyId: fixture.companyId, patch })),
      );
      expect(failure, JSON.stringify(patch)).toMatchObject({ status: 403 });
    }
    await expectBlockKept(fixture, before);
  });

  it("refuses a call with no agent behind it and no actor field at all", async () => {
    const fixture = await seed(BOARD_BLOCK);
    const before = await readIssue(fixture.issue.id);

    const failure = await failureOf(
      fixture.services.issues.update({ issueId: fixture.issue.id, companyId: fixture.companyId, patch: { status: "todo" } }),
    );

    expect(failure).toMatchObject({ status: 403, message: HUMAN_OWNED_BLOCK_MESSAGE });
    await expectBlockKept(fixture, before);
  });

  it("still lets a plugin that names a user as the actor lift the block, as before", async () => {
    const fixture = await seed(BOARD_BLOCK);

    await fixture.services.issues.update({
      issueId: fixture.issue.id,
      companyId: fixture.companyId,
      patch: { status: "todo", actorUserId: "board-user" },
    });

    const after = await readIssue(fixture.issue.id);
    expect(after.status).toBe("todo");
    expect(after.unblockDescriptor).toBeNull();
  });

  it("still lets an agent behind the call change other fields of the issue, and lift a block that nobody human owns", async () => {
    const owned = await seed(BOARD_BLOCK);
    await owned.asAgent(() =>
      owned.services.issues.update({ issueId: owned.issue.id, companyId: owned.companyId, patch: { title: "Renamed" } }),
    );
    expect(await readIssue(owned.issue.id)).toMatchObject({ title: "Renamed", status: "blocked", unblockDescriptor: BOARD_BLOCK });

    const own = await seed(null);
    await own.asAgent(() =>
      own.services.issues.update({ issueId: own.issue.id, companyId: own.companyId, patch: { status: "todo" } }),
    );
    expect((await readIssue(own.issue.id)).status).toBe("todo");
  });
});
