import { randomUUID } from "node:crypto";
import { and, asc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selectAgentQueuedRuns } from "../services/queued-run-claim-order.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COMPANY_COUNT = 4;
const AGENTS_PER_COMPANY = 3;
// Override to reproduce the benchmark at a larger scale.
const FINISHED_RUNS_PER_AGENT = Number(process.env.QUEUED_RUNS_PLAN_FINISHED_PER_AGENT) || 500;
const QUEUED_RUNS_OF_TARGET = 20;
const QUEUED_RUNS_OF_OTHERS = 3;
const SNAPSHOT_KB = 4;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  Plans?: PlanNode[];
};

async function explain(db: ReturnType<typeof createDb>, query: SQLWrapper) {
  const json = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
  const text = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
  const root = ((json as unknown as Array<Record<string, unknown>>)[0]!["QUERY PLAN"] as Array<{
    Plan: PlanNode;
    "Execution Time": number;
  }>)[0]!;
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(walk); };
  walk(root.Plan);
  return {
    ms: root["Execution Time"],
    buffers: root.Plan["Shared Hit Blocks"] + root.Plan["Shared Read Blocks"],
    nodes,
    text: (text as unknown as Array<Record<string, string>>).map((row) => row["QUERY PLAN"]).join("\n"),
  };
}

describeEmbeddedPostgres("an agent's queued-run read", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const target = { companyId: "", agentId: "" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-queued-runs-plan-");
    db = createDb(tempDb.connectionString);
    const padding = "x".repeat(SNAPSHOT_KB * 1024);
    const day = 24 * 60 * 60 * 1000;
    for (let c = 0; c < COMPANY_COUNT; c += 1) {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Company ${c}`,
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      for (let a = 0; a < AGENTS_PER_COMPANY; a += 1) {
        const agentId = randomUUID();
        await db.insert(agents).values({
          id: agentId, companyId, name: `Agent ${c}-${a}`, role: "engineer", status: "idle",
          adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
        });
        if (c === 0 && a === 0) Object.assign(target, { companyId, agentId });
        const queued = c === 0 && a === 0 ? QUEUED_RUNS_OF_TARGET : QUEUED_RUNS_OF_OTHERS;
        const runs = Array.from({ length: FINISHED_RUNS_PER_AGENT + queued }, (_, i) => {
          const finished = i < FINISHED_RUNS_PER_AGENT;
          const createdAt = new Date(Date.now() - (FINISHED_RUNS_PER_AGENT + queued - i) * (day / 100));
          return {
            companyId,
            agentId,
            status: finished ? (i % 7 === 0 ? "failed" : "succeeded") : "queued",
            createdAt,
            startedAt: finished ? createdAt : null,
            finishedAt: finished ? new Date(createdAt.getTime() + 60_000) : null,
            contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned", padding },
          };
        });
        for (let i = 0; i < runs.length; i += 250) {
          await db.insert(heartbeatRuns).values(runs.slice(i, i + 250));
        }
      }
    }
    await db.execute(sql`ANALYZE heartbeat_runs`);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads only the company's queued runs through an index (benchmark)", async () => {
    // The read before this change: no company predicate, sorted in SQL.
    const before = db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, target.agentId), eq(heartbeatRuns.status, "queued")))
      .orderBy(asc(heartbeatRuns.createdAt));
    const after = selectAgentQueuedRuns(db, { ...target, cutoff: null });

    expect((await after).map((run) => run.id).sort()).toEqual((await before).map((run) => run.id).sort());
    expect(await after).toHaveLength(QUEUED_RUNS_OF_TARGET);

    const beforePlan = await explain(db, before);
    const afterPlan = await explain(db, after);
    const totalRuns = COMPANY_COUNT * AGENTS_PER_COMPANY * FINISHED_RUNS_PER_AGENT;
    console.log(
      `BENCHMARK finished_runs=${totalRuns} queued_target=${QUEUED_RUNS_OF_TARGET} ` +
        `before=${beforePlan.ms.toFixed(2)}ms/${beforePlan.buffers}buffers ` +
        `after=${afterPlan.ms.toFixed(2)}ms/${afterPlan.buffers}buffers`,
    );
    console.log(`BEFORE PLAN\n${beforePlan.text}\nAFTER PLAN\n${afterPlan.text}`);

    // Without company_id the planner walks every company's index entries (or
    // skip-scans them on PostgreSQL 18); with it, it seeks this company's queue.
    const seeksCompanyQueue = (node: PlanNode) =>
      Boolean(node["Index Name"]?.startsWith("heartbeat_runs_company_") &&
        node["Index Cond"]?.includes("company_id =") && node["Index Cond"].includes("status ="));
    expect(afterPlan.nodes.some(seeksCompanyQueue)).toBe(true);
    expect(afterPlan.nodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
    expect(afterPlan.buffers).toBeLessThan(beforePlan.buffers);
  }, 60_000);
});
