import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent wait state tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service wait state", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-wait-state-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reports active waits and the next check without changing the stored status", async () => {
    const companyId = randomUUID();
    const waitingAgentId = randomUUID();
    const idleAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const id of [waitingAgentId, idleAgentId]) {
      await db.insert(agents).values({ id, companyId, name: `Agent ${id.slice(0, 4)}`, role: "engineer", status: "idle", adapterType: "process" });
    }
    const soon = new Date(Date.now() + 10 * 60_000);
    const later = new Date(Date.now() + 60 * 60_000);
    const past = new Date(Date.now() - 60_000);
    const issue = (title: string, values: Partial<typeof issues.$inferInsert>) => ({
      id: randomUUID(),
      companyId,
      title,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: waitingAgentId,
      ...values,
    });
    await db.insert(issues).values([
      issue("CI wait", { monitorNextCheckAt: later }),
      issue("Deploy wait", { status: "in_review", monitorNextCheckAt: soon }),
      // Not active: past due (the monitor wake owns it), done, or someone else's.
      issue("Overdue wait", { monitorNextCheckAt: past }),
      issue("Closed wait", { status: "done", monitorNextCheckAt: later }),
      issue("Other agent", { assigneeAgentId: idleAgentId, status: "todo", monitorNextCheckAt: null }),
    ]);

    const svc = agentService(db);
    const listed = await svc.list(companyId);
    const waiting = listed.find((agent) => agent.id === waitingAgentId);
    const idle = listed.find((agent) => agent.id === idleAgentId);

    expect(waiting?.status).toBe("idle");
    expect(waiting?.waitState).toEqual({ activeWaitCount: 2, nextCheckAt: soon.toISOString() });
    expect(idle?.waitState).toBeNull();
    expect((await svc.getById(waitingAgentId))?.waitState).toEqual({
      activeWaitCount: 2,
      nextCheckAt: soon.toISOString(),
    });
  });
});
