import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, runUsageRecords } from "@paperclipai/db";
import { companyService } from "../services/companies.js";
import { runUsageRecordService } from "../services/run-usage-records.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("run usage records and company removal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-usage-removal-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithRecord(): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const finished = new Date(Date.now() - 60 * 60_000);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date(finished.getTime() - 60_000),
      finishedAt: finished,
    });
    await runUsageRecordService(db).runPass({ companyId });
    return companyId;
  }

  it("removes a company's usage records with the company and keeps other companies' records", async () => {
    const removed = await seedCompanyWithRecord();
    const kept = await seedCompanyWithRecord();

    await companyService(db).remove(removed);

    expect(await db.select().from(runUsageRecords).where(eq(runUsageRecords.companyId, removed))).toHaveLength(0);
    expect(await db.select().from(runUsageRecords).where(eq(runUsageRecords.companyId, kept))).toHaveLength(1);
  });
});
