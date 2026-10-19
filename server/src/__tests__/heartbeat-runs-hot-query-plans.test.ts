import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { listSupersededExhaustedRunIds } from "../services/attention-exhausted-runs.js";
import { heartbeatService } from "../services/heartbeat.js";

/**
 * Guards the plans of two hot heartbeat_runs reads. A run's context_snapshot is
 * large and stored out of line (TOAST): a plan that evaluates a context
 * expression on every run reads all of them, which on a large table means
 * gigabytes per call. The planner does not cost that read, so it picks such a
 * plan on its own whenever an index does not match the query's expression.
 *
 * - Hot query 1: recovery's "does the issue have a live path besides this
 *   recovery action" check (reconcileStrandedAssignedIssues).
 * - Hot query 2: the attention feed's "did a newer run supersede this
 *   exhausted run" check (attentionService.list). An exhausted run stays in the
 *   feed until something supersedes it, so the check also runs for old runs.
 *
 * The test seeds a table large enough that the default plan has to choose,
 * runs the real service code, captures the statements it sends, and explains
 * each one with its own parameters. It asserts plan shape and buffer counts,
 * never wall-clock time. Every plan here is the planner's own choice under
 * default settings (no enable_seqscan=off): the assertions prove the default
 * plan picks the index on a realistic table, not only that the index is usable.
 */
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const ISSUE_OR_TASK_INDEX = "heartbeat_runs_company_issue_or_task_idx";
const NO_ISSUE_INDEX = "heartbeat_runs_company_agent_no_issue_created_idx";
const RUNS = 6_000;
const ISSUES = 300;
const AGENTS = 26;
/**
 * Shared buffers a statement may touch. Query 1 reads one issue's runs (about
 * 20 here). Query 2 reads at most one issue's runs per exhausted run (26 here,
 * about 600 buffers). Both stay far below what reading every large context
 * touches, which the seed check asserts.
 */
const QUERY_1_BUFFER_BOUND = 100;
const QUERY_2_BUFFER_BOUND = 1_000;
/** Before every seeded run (the seed spans the last day). */
const OLD = new Date(Date.now() - 2 * 24 * 3_600_000);

type Captured = { query: string; params: unknown[] };
type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; Filter?: string; Plans?: PlanNode[] } & Record<string, unknown>;

function recordingDb(db: Db) {
  const statements: Captured[] = [];
  const recorded = drizzle(db.$client, {
    schema: db._.fullSchema,
    logger: { logQuery: (query: string, params: unknown[]) => { statements.push({ query, params }); } },
  }) as unknown as Db;
  return { db: recorded, statements };
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** A captured parameter as an SQL literal, for EXECUTE of a prepared statement. */
function sqlLiteral(value: unknown) {
  if (value === null || value === undefined) return "null";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `'${text.replaceAll("'", "''")}'`;
}

/** The SELECT list of a statement, up to its first FROM. */
function selectList(query: string) {
  return /^\s*select\s+([\s\S]*?)\s+from\s/i.exec(query)?.[1] ?? query;
}

describeEmbeddedPostgres("heartbeat_runs hot query plans", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentIds = Array.from({ length: AGENTS }, () => randomUUID());
  const issueIds = Array.from({ length: ISSUES }, () => randomUUID());
  const sourceIssueId = issueIds[7]!;
  let toastPages = 0;

  let preparedCount = 0;

  /**
   * Explains a captured statement with its parameters. A custom plan sees the values. A generic
   * plan does not: the driver's unnamed statements are always planned with their values, so the
   * generic plan comes from a named prepared statement under force_generic_plan, the plan a server
   * runs once it caches one for a statement it has prepared.
   */
  async function explain(statement: Captured, genericPlan = false) {
    return db.$client.begin(async (tx) => {
      let rows: unknown[];
      if (genericPlan) {
        const name = `hot_query_${(preparedCount += 1)}`;
        await tx.unsafe("set local plan_cache_mode = force_generic_plan");
        await tx.unsafe(`prepare ${name} as ${statement.query}`);
        try {
          const args = statement.params.map(sqlLiteral).join(", ");
          rows = await tx.unsafe(`explain (analyze, buffers, format json) execute ${name}${args ? `(${args})` : ""}`);
        } finally {
          await tx.unsafe(`deallocate ${name}`);
        }
      } else {
        rows = await tx.unsafe(`explain (analyze, buffers, format json) ${statement.query}`, statement.params as never[]);
      }
      const plan = (Object.values(rows[0] as Record<string, unknown>)[0] as Array<{ Plan: PlanNode }>)[0]!.Plan;
      const nodes = planNodes(plan);
      return {
        nodes,
        // A generic plan keeps the $n placeholders in its conditions; a custom plan has the values.
        generic: /\$\d/.test(JSON.stringify(nodes)),
        shape: nodes.map((node) => [node["Node Type"], node["Index Name"] ?? node["Relation Name"], `est ${node["Plan Rows"]} rows`, node["Index Cond"], node.Filter].filter(Boolean).join(" ")).join(" > "),
        buffers: Number(plan["Shared Hit Blocks"] ?? 0) + Number(plan["Shared Read Blocks"] ?? 0),
        seqScans: nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "heartbeat_runs"),
        usesIssueIndex: nodes.some((node) => node["Index Name"] === ISSUE_OR_TASK_INDEX),
        usesNoIssueIndex: nodes.some((node) => node["Index Name"] === NO_ISSUE_INDEX),
        // A filter evaluates on every run the scan visits, so a context expression there reads
        // (detoasts) the context of each visited run, matching or not.
        contextFilters: nodes.filter((node) => node["Relation Name"] === "heartbeat_runs" && node.Filter?.includes("context_snapshot")).map((node) => node.Filter),
      };
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runs-hot-plans-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Plans", issuePrefix: "PLN", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values(agentIds.map((id, index) => ({
      id, companyId, name: `Agent ${index}`, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(issues).values(issueIds.map((id, index) => ({
      id, companyId, title: `Issue ${index}`, status: index === 7 ? "blocked" : "done", priority: "medium",
      assigneeAgentId: agentIds[index % AGENTS], issueNumber: index + 1, identifier: `PLN-${index + 1}`,
    })));
    // Mostly finished runs; every 10th is live (queued or running, none on the recovery action's
    // issue) and every 13th has no issue, like a timer run. Every 4th run carries a ~40 kB context and
    // three carry ~1.5 MB, both incompressible so they are stored out of line; the rest stay small. A
    // 1 kB excerpt gives the heap a realistic width, so the planner has a real choice between a scan
    // and an index.
    const agentArray = `array[${agentIds.map((id) => `'${id}'::uuid`).join(",")}]`;
    const issueArray = `array[${issueIds.map((id) => `'${id}'`).join(",")}]`;
    await db.$client.unsafe(`
      insert into heartbeat_runs (company_id, agent_id, invocation_source, status, started_at, finished_at, created_at, updated_at, stdout_excerpt, result_json, context_snapshot)
      select '${companyId}', (${agentArray})[1 + (g % ${AGENTS})], 'automation',
        case when g % 10 = 0 then (array['queued', 'running'])[1 + (g / 10) % 2]
          else (array['succeeded', 'succeeded', 'succeeded', 'failed', 'cancelled', 'timed_out'])[1 + (g % 6)] end,
        now() - g * interval '14 seconds', now() - g * interval '14 seconds' + interval '10 seconds', now() - g * interval '14 seconds', now(),
        repeat('x', 1024), jsonb_build_object('summary', repeat('y', 2000)),
        case when g % 13 = 0 then '{}'::jsonb
          else jsonb_build_object(case when g % 9 = 0 then 'taskId' else 'issueId' end, (${issueArray})[1 + (g % ${ISSUES})]) end
        || jsonb_build_object('paperclipWake', case
            when g <= 3 then (select string_agg(md5(g::text || ':' || i::text), '') from generate_series(1, 48000) i)
            when g % 4 = 0 then (select string_agg(md5(g::text || ':' || i::text), '') from generate_series(1, 1250) i)
            else 'short' end)
      from generate_series(1, ${RUNS}) g`);
    const insertExhaustedRun = async (agentId: string, createdAt: Date, contextSnapshot: Record<string, unknown>) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId, invocationSource: "automation", status: "failed", errorCode: "adapter_failed",
        contextSnapshot, scheduledRetryAttempt: 4, scheduledRetryReason: "transient_failure",
        createdAt, updatedAt: createdAt, finishedAt: createdAt,
      });
      await db.insert(heartbeatRunEvents).values({
        companyId, runId: id, agentId, seq: 1, eventType: "lifecycle", payload: {}, createdAt,
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      });
    };
    // One exhausted run per agent, so the feed checks a realistic number of agents; the last has no issue.
    for (const [index, agentId] of agentIds.entries()) {
      await insertExhaustedRun(agentId, new Date(Date.now() - (index + 1) * 60_000), index === AGENTS - 1 ? {} : { issueId: issueIds[(index * 11) % ISSUES] });
    }
    // An old exhausted run without an issue, older than every seeded run, of an agent whose runs all
    // have an issue (only agents 0 and 13 have runs without one). Nothing supersedes it, so the
    // check has to rule out every later run of the agent: about 230 here.
    await insertExhaustedRun(agentIds[5]!, OLD, {});
    // An agent-owned recovery action on a blocked issue: the sweep checks it for a new live path.
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "stranded_assigned_issue", status: "active", ownerType: "agent",
      ownerAgentId: agentIds[0], previousOwnerAgentId: agentIds[0], returnOwnerAgentId: agentIds[0], cause: "process_lost",
      fingerprint: `plans:${sourceIssueId}`, evidence: { latestRunId: null }, nextAction: "Recover",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: agentIds[0], attempt: 1, maxAttempts: 5 }, attemptCount: 1, maxAttempts: 5,
    });
    await db.$client.unsafe("analyze heartbeat_runs");
    const [size] = await db.$client.unsafe<Array<{ pages: string }>>(
      "select pg_relation_size(reltoastrelid) / current_setting('block_size')::int as pages from pg_class where relname = 'heartbeat_runs'",
    );
    toastPages = Number(size!.pages);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seeds a table whose context reads would dwarf the buffer bound", () => {
    // Without this, a low buffer count would prove nothing.
    expect(toastPages).toBeGreaterThan(QUERY_2_BUFFER_BOUND * 5);
  });

  it("hot query 1 (recovery live-path check) uses the issue index, never scans every run, in custom and generic plans", async () => {
    const recorder = recordingDb(db);
    await heartbeatService(recorder.db).reconcileStrandedAssignedIssues();
    const hot = recorder.statements.filter(({ query }) => query.includes("'recoveryActionId', '') <>") && query.includes("from \"heartbeat_runs\""));
    expect(hot, "reconcileStrandedAssignedIssues no longer sends the recovery live-path check; update this guard").toHaveLength(1);
    // The sweep sends the live statuses (queued, running, scheduled_retry), and the issue has no live
    // run: the status index would read the context of every live run. The terminal statuses, which
    // match most runs, check the same for a plan that cannot rely on the status filter. A generic
    // plan cannot see the statuses at all.
    const live = hot[0]!;
    const terminal: Captured = {
      query: live.query,
      params: live.params.map((param) => (param === "queued" ? "succeeded" : param === "running" ? "failed" : param === "scheduled_retry" ? "cancelled" : param)),
    };
    for (const statement of [live, terminal]) {
      for (const genericPlan of [false, true]) {
        const plan = await explain(statement, genericPlan);
        const label = `statuses ${JSON.stringify(statement.params.slice(1, 4))}, ${genericPlan ? "generic" : "custom"} plan (${plan.shape})`;
        expect(plan.generic, `${label}: plan kind`).toBe(genericPlan);
        expect(plan.seqScans, `${label}: sequential scan of heartbeat_runs`).toEqual([]);
        expect(plan.usesIssueIndex, `${label}: does not use ${ISSUE_OR_TASK_INDEX}`).toBe(true);
        expect(plan.buffers, `${label}: shared buffers`).toBeLessThan(QUERY_1_BUFFER_BOUND);
      }
    }
  });

  it("hot query 2 (attention feed's newer-run check) uses the issue index and reads no run context", async () => {
    const recorder = recordingDb(db);
    await attentionService(recorder.db).list(companyId, { includeDismissed: true, all: true, allowUnscopedAll: true });
    const hot = recorder.statements.filter(({ query }) => query.includes("from (values") && query.includes("from \"heartbeat_runs\""));
    // One statement for the exhausted runs on an issue, one for those without.
    expect(hot, "attentionService.list no longer sends the newer-run checks; update this guard").toHaveLength(2);
    for (const statement of hot) await expectNewerRunCheckPlans(statement);
  });

  it("hot query 2 checks many old exhausted runs without an issue through the no-issue index", async () => {
    // The planner changes plan with the number of candidates: 11 old exhausted runs without an
    // issue, on agents whose later runs all have one.
    const candidates = agentIds.slice(1, 12).map((agentId) => ({ id: randomUUID(), agentId, createdAt: OLD, issueId: null }));
    const recorder = recordingDb(db);
    expect(await listSupersededExhaustedRunIds(recorder.db, companyId, candidates)).toEqual(new Set());
    const hot = recorder.statements.filter(({ query }) => query.includes("from (values"));
    expect(hot).toHaveLength(1);
    await expectNewerRunCheckPlans(hot[0]!);
  });

  /** A newer-run check uses its index, reads no run context, and stays within the bound. */
  async function expectNewerRunCheckPlans(statement: Captured) {
    const issueCheck = !statement.query.includes(" is null");
    for (const genericPlan of [false, true]) {
      const plan = await explain(statement, genericPlan);
      const label = `${issueCheck ? "issue" : "no-issue"} check, ${genericPlan ? "generic" : "custom"} plan (${plan.shape})`;
      expect(plan.generic, `${label}: plan kind`).toBe(genericPlan);
      expect(plan.seqScans, `${label}: sequential scan of heartbeat_runs`).toEqual([]);
      if (issueCheck) expect(plan.usesIssueIndex, `${label}: does not use ${ISSUE_OR_TASK_INDEX}`).toBe(true);
      else expect(plan.usesNoIssueIndex, `${label}: does not use ${NO_ISSUE_INDEX}`).toBe(true);
      expect(plan.contextFilters, `${label}: reads the context of every run it visits`).toEqual([]);
      expect(plan.buffers, `${label}: shared buffers`).toBeLessThan(QUERY_2_BUFFER_BOUND);
    }
  }

  it("keeps context_snapshot and result_json out of the hot statements' select lists", async () => {
    const recorder = recordingDb(db);
    await heartbeatService(recorder.db).reconcileStrandedAssignedIssues();
    await attentionService(recorder.db).list(companyId, { includeDismissed: true, all: true, allowUnscopedAll: true });
    const callSites: Array<{ name: string; match: (query: string) => boolean }> = [
      { name: "recovery live-path check (recovery/service.ts sourceHasNewPathOutsideRecoveryAction)", match: (query) => query.includes("'recoveryActionId', '') <>") },
      { name: "attention newer-run check (attention-exhausted-runs.ts listSupersededExhaustedRunIds)", match: (query) => query.includes("from (values") },
    ];
    for (const site of callSites) {
      const statements = recorder.statements.filter(({ query }) => site.match(query) && query.includes("\"heartbeat_runs\""));
      expect(statements.length, `${site.name} was not sent`).toBeGreaterThan(0);
      for (const { query } of statements) {
        for (const column of ["context_snapshot", "result_json"]) {
          expect(selectList(query), `${site.name} selects ${column}: a hot path must not load (detoast) it; select only the columns it needs`)
            .not.toContain(column);
        }
      }
    }
  });
});
