import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { undeliveredLegacyUserCommentIds } from "./explicit-native-continuation.js";

const COMMENT_COUNT = 20000;
const CONSUMED_RUN_COUNT = 800;
const BOUND_MS = 1000;
const SEED_BATCH = 1000;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("undelivered saved comments on a long issue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("long-issue-saved-comments-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  it("returns exactly the undelivered user comments, in order, within a bounded time", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Long issue", defaultResponsibleUserId: "board", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long", status: "in_progress", assigneeAgentId: agentId });

    const base = Date.parse("2026-09-11T00:00:00Z");
    const ids = Array.from({ length: COMMENT_COUNT }, () => randomUUID());
    const excluded = new Set<string>();
    const rows = ids.map((id, index) => {
      const kind = index % 10;
      const row = { id, companyId, issueId, authorType: "user" as const, authorUserId: "board", body: `message ${index}`,
        createdAt: new Date(base + index * 1000) };
      if (kind === 1) { excluded.add(id); return { ...row, authorType: "agent" as const, authorUserId: null, authorAgentId: agentId }; }
      if (kind === 2) { excluded.add(id); return { ...row, deletedAt: new Date(base) }; }
      if (kind === 3) { excluded.add(id); return { ...row, body: "  " }; }
      return row;
    });
    for (let offset = 0; offset < rows.length; offset += SEED_BATCH) {
      await db.insert(issueComments).values(rows.slice(offset, offset + SEED_BATCH));
    }

    // Earlier runs consumed some saved comments, via both wake context shapes.
    const consumable = ids.filter((id) => !excluded.has(id));
    const runs = Array.from({ length: CONSUMED_RUN_COUNT }, (_, index) => {
      const slice = consumable.slice(index * 4, index * 4 + 4);
      slice.forEach((id) => excluded.add(id));
      return { id: randomUUID(), companyId, agentId, status: "succeeded", runtimeMode: "native" as const,
        startedAt: new Date(base), contextSnapshot: index % 2 === 0
          ? { issueId, wakeCommentId: slice[0], wakeCommentIds: slice }
          : { issueId, wakeCommentIds: slice } };
    });
    await db.insert(heartbeatRuns).values(runs);
    // A cancelled-before-start run consumed nothing; its comment stays deliverable.
    const unconsumed = consumable[CONSUMED_RUN_COUNT * 4 + 7]!;
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId, status: "cancelled",
      runtimeMode: "native", contextSnapshot: { issueId, wakeCommentIds: [unconsumed] } });

    const started = performance.now();
    const result = await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, ids);
    const elapsed = performance.now() - started;

    expect(result).toEqual(ids.filter((id) => !excluded.has(id)));
    expect(result).toContain(unconsumed);
    expect(elapsed, "elapsed ms").toBeLessThan(BOUND_MS);
  }, 60000);

  it("fails closed for ids that belong to another issue", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scope", defaultResponsibleUserId: "board", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "A", status: "in_progress", assigneeAgentId: agentId },
      { id: otherIssueId, companyId, title: "B", status: "in_progress", assigneeAgentId: agentId },
    ]);
    const mine = randomUUID(), foreign = randomUUID();
    await db.insert(issueComments).values([
      { id: mine, companyId, issueId, authorType: "user", authorUserId: "board", body: "mine" },
      { id: foreign, companyId, issueId: otherIssueId, authorType: "user", authorUserId: "board", body: "foreign" },
    ]);
    expect(await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, [foreign, mine])).toEqual([mine]);
    expect(await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, [])).toEqual([]);
  }, 30000);
});
