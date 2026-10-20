import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { issueIdEqualsText } from "../services/issue-id-match.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RUN_COUNT = 5_000;
const SNAPSHOT_KB = 64;
const SECRET = "lookup-index-secret-value";

async function planOf(db: ReturnType<typeof createDb>, query: ReturnType<typeof sql>) {
  const rows = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
  const plan = (rows as unknown as Array<Record<string, unknown>>)[0]?.["QUERY PLAN"];
  const root = (Array.isArray(plan) ? plan[0] : plan) as { "Execution Time": number };
  return { text: JSON.stringify(plan), ms: root["Execution Time"] };
}

describeEmbeddedPostgres("secret-redaction lookup and typed issue joins", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousKey: string | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueIds = Array.from({ length: 3 }, () => randomUUID());
  const registryRunIds: string[] = [];

  beforeAll(async () => {
    previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-redaction-lookup-index-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values(Array.from({ length: RUN_COUNT }, (_, i) => ({
      id: i < issueIds.length ? issueIds[i]! : randomUUID(),
      companyId,
      title: `Issue ${i}`,
      assigneeAgentId: agentId,
    })));
    const padding = "x".repeat(SNAPSHOT_KB * 1024);
    const runs = Array.from({ length: RUN_COUNT }, (_, i) => {
      const issueId = i % 2 === 0 ? issueIds[i % issueIds.length]! : randomUUID();
      return {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        // Half the runs carry the issue under the nested key, as real snapshots do.
        contextSnapshot: i % 4 === 1
          ? { paperclipIssue: { id: issueId }, padding }
          : { issueId, padding },
      };
    });
    for (let i = 0; i < runs.length; i += 250) {
      await db.insert(heartbeatRuns).values(runs.slice(i, i + 250));
    }
    registryRunIds.push(runs[0]!.id, runs[1]!.id);
    await createRunSecretRedactionRegistry(db).register(companyId, runs[0]!.id, SECRET);
    // runs[1] is nested-key, issueIds[1]; a registry-less run for the same issue must not matter.
    await createRunSecretRedactionRegistry(db).register(companyId, runs[1]!.id, `${SECRET}-nested`);
    await db.execute(sql`ANALYZE heartbeat_runs`);
    await db.execute(sql`ANALYZE issues`);
  }, 120_000);

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey;
    await tempDb?.cleanup();
  });

  it("redacts values registered on runs that reference the issue, under either key", async () => {
    const registry = createRunSecretRedactionRegistry(db);
    const direct = await registry.redactForIssue(companyId, issueIds[0]!, { body: `a ${SECRET} b` });
    expect(direct.body).not.toContain(SECRET);
    const nestedRun = await db.select({ ctx: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${registryRunIds[1]}`);
    const nestedIssue = (nestedRun[0]!.ctx as { paperclipIssue: { id: string } }).paperclipIssue.id;
    const nested = await registry.redactForIssue(companyId, nestedIssue, { body: `${SECRET}-nested` });
    expect(nested.body).not.toContain(SECRET);
    const other = await registry.redactForIssue(companyId, randomUUID(), { body: SECRET });
    expect(other.body).toBe(SECRET);
  });

  it("uses the partial expression indexes for the registry lookup (benchmark)", async () => {
    const issueId = issueIds[0]!;
    const predicate = (prefilter: boolean) => sql`
      SELECT jsonb_build_object('paperclipSecretRedactions', context_snapshot -> 'paperclipSecretRedactions')
      FROM heartbeat_runs
      WHERE company_id = ${companyId}
        ${prefilter ? sql`AND context_snapshot ? 'paperclipSecretRedactions'` : sql``}
        AND (context_snapshot ->> 'issueId' = ${issueId}
          OR context_snapshot -> 'paperclipIssue' ->> 'id' = ${issueId})`;
    // Before: drop the new indexes and use the old predicate (scan + detoast).
    await db.execute(sql`DROP INDEX heartbeat_runs_company_ctx_issue_redaction_idx`);
    await db.execute(sql`DROP INDEX heartbeat_runs_company_ctx_pcissue_redaction_idx`);
    const before = await planOf(db, predicate(false));
    const migration = await import("node:fs").then((fs) => fs.readFileSync(
      new URL("../../../packages/db/src/migrations/0363_jittery_otto_octavius.sql", import.meta.url), "utf8"));
    for (const stmt of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt));
    await db.execute(sql`ANALYZE heartbeat_runs`);
    const after = await planOf(db, predicate(true));
    console.log(`BENCHMARK runs=${RUN_COUNT} snapshot=${SNAPSHOT_KB}KB before=${before.ms.toFixed(1)}ms after=${after.ms.toFixed(1)}ms`);
    expect(before.text).toContain("Seq Scan");
    expect(after.text).not.toContain("Seq Scan");
    expect(after.text).toContain("heartbeat_runs_company_ctx_issue_redaction_idx");
    expect(after.text).toContain("heartbeat_runs_company_ctx_pcissue_redaction_idx");
    expect(after.ms).toBeLessThan(before.ms);
  }, 60_000);

  describe("bound task keys", () => {
    // Bound parameters reach PostgreSQL untyped; a non-UUID key must match nothing, not raise 22P02.
    it.each(["__heartbeat__", "custom:opaque-task", "not-a-uuid", ""])(
      "returns no match for the bound non-UUID key %j",
      async (key) => {
        const rows = await db.select({ id: issues.id }).from(issues).where(issueIdEqualsText(sql`${key}`));
        expect(rows).toEqual([]);
      },
    );

    it("still matches a bound canonical UUID key and rejects uppercase or padded forms", async () => {
      const matches = (key: string) =>
        db.select({ id: issues.id }).from(issues).where(issueIdEqualsText(sql`${key}`));
      expect(await matches(issueIds[0]!)).toEqual([{ id: issueIds[0] }]);
      expect(await matches(issueIds[0]!.toUpperCase())).toEqual([]);
      expect(await matches(` ${issueIds[0]}`)).toEqual([]);
    });
  });

  describe("typed issue join", () => {
    const join = (typed: boolean) => sql`
      SELECT agent_wakeup_requests.id FROM agent_wakeup_requests
      JOIN issues ON issues.company_id = agent_wakeup_requests.company_id
        AND ${typed
          ? issueIdEqualsText(sql`agent_wakeup_requests.payload->>'issueId'`)
          : sql`issues.id::text = agent_wakeup_requests.payload->>'issueId'`}
      WHERE agent_wakeup_requests.status = 'deferred_issue_execution'`;

    beforeAll(async () => {
      const payloads: unknown[] = [
        { issueId: issueIds[0] },
        { issueId: issueIds[1]!.toUpperCase() },
        { issueId: "not-a-uuid" },
        { issueId: ` ${issueIds[2]}` },
        { issueId: 7 },
        {},
      ];
      await db.insert(agentWakeupRequests).values(payloads.map((payload) => ({
        companyId, agentId, source: "automation", status: "deferred_issue_execution", payload,
      })));
      await db.execute(sql`ANALYZE agent_wakeup_requests`);
    });

    it("returns the same rows as the text comparison and never raises on invalid ids", async () => {
      const oldRows = await db.execute(join(false));
      const newRows = await db.execute(join(true));
      expect(oldRows).toHaveLength(1);
      expect(newRows).toEqual(oldRows);
    });

    it("looks issues up through an id index instead of scanning them", async () => {
      const oldPlan = await planOf(db, join(false));
      const newPlan = await planOf(db, join(true));
      console.log(`BENCHMARK join issues=${RUN_COUNT} before=${oldPlan.ms.toFixed(2)}ms after=${newPlan.ms.toFixed(2)}ms`);
      const seqScansIssues = (text: string) => /"Node Type":"Seq Scan"[^{}]*"Relation Name":"issues"/.test(text);
      expect(seqScansIssues(oldPlan.text)).toBe(true);
      expect(seqScansIssues(newPlan.text)).toBe(false);
      expect(newPlan.text).toMatch(/"Index Name":"issues_/);
    });
  });
});
