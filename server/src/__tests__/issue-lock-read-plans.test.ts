import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordingDb } from "./helpers/tool-gateway-listing-fixture.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const ISSUES = 8;
const RUNS_PER_ISSUE = 400;

type PlanNode = {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
};

/** Rows each table's scans read in one statement, from its executed plan. */
function rowsReadByTable(node: PlanNode, totals: Map<string, number> = new Map()) {
  const table = node["Relation Name"];
  if (table) {
    const read = ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) +
      (node["Rows Removed by Index Recheck"] ?? 0)) * (node["Actual Loops"] ?? 1);
    totals.set(table, (totals.get(table) ?? 0) + read);
  }
  for (const child of node.Plans ?? []) rowsReadByTable(child, totals);
  return totals;
}

// These reads run inside transactions that hold issue row locks (the wake
// queue's issue lock, run claims, wakes). Each must read only the rows of the
// issue it is about, through an index, and never every run of the company.
describeEmbeddedPostgres("reads under the issue lock stay on the issue's rows", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();
  let issueId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-lock-read-plans-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
      values ('plans-user', 'Plans User', 'plans-user@example.test', true, now(), now())`);
    await db.execute(sql`insert into companies (id, name, issue_prefix, default_responsible_user_id, require_board_approval_for_new_agents)
      values (${companyId}, 'Plans', 'PLN', 'plans-user', false)`);
    await db.execute(sql`insert into agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      values (${agentId}, ${companyId}, 'Worker', 'engineer', 'idle', 'codex_local', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`insert into issues (id, company_id, title, status, priority, assignee_agent_id, responsible_user_id, issue_number, identifier)
      select gen_random_uuid(), ${companyId}, 'Issue ' || g, 'in_progress', 'medium', ${agentId}, 'plans-user', g, 'PLN-' || g
      from generate_series(1, ${ISSUES}) g`);
    // Many ended legacy conversation runs per issue; some kept a process id.
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status, error_code,
        runtime_mode, context_snapshot, runner_profile_json, process_pid, next_event_seq, created_at, started_at, finished_at)
      select i.company_id, i.assignee_agent_id, 'assignment', 'system',
        (array['failed','cancelled','interrupted','timed_out'])[1 + g % 4], 'adapter_failed', 'legacy',
        jsonb_build_object('issueId', i.id::text), jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local')),
        case when g % 20 = 0 then 2147480000 + g end, 2, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now()
      from issues i, generate_series(1, ${RUNS_PER_ISSUE}) g where i.company_id = ${companyId}`);
    await db.execute(sql`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, stream, level, payload)
      select r.company_id, r.id, r.agent_id, 1, 'adapter.invoke', 'system', 'info', jsonb_build_object('adapterType', 'codex_local')
      from heartbeat_runs r where r.company_id = ${companyId}`);
    // Every issue holds an active reconciliation hold and older resolved ones.
    await db.execute(sql`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, evidence, next_action, resolved_at)
      select i.company_id, i.id, 'active_run_watchdog', case when g = 1 then 'active' else 'resolved' end, 'board',
        'legacy_execution_requires_reconciliation', 'legacy-execution:' || r.id,
        jsonb_build_object('runId', r.id::text, 'automaticRecovery', jsonb_build_object('replay', 'blocked')),
        'Reconcile the run.', case when g = 1 then null else now() end
      from issues i, generate_series(1, 4) g,
        lateral (select id from heartbeat_runs hr where hr.company_id = i.company_id and hr.context_snapshot->>'issueId' = i.id::text
          order by hr.created_at desc offset g - 1 limit 1) r
      where i.company_id = ${companyId}`);
    await db.execute(sql`analyze`);
    const [first] = (await db.execute(sql`select id from issues where company_id = ${companyId} order by issue_number limit 1`)) as unknown as Array<{ id: string }>;
    issueId = first!.id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** The largest number of heartbeat_runs rows any one recorded statement read.
   * Sequential scans are off, so the check does not depend on the planner's
   * cost choice at this size: a predicate no index serves still reads every run.
   */
  async function maxRunRowsRead(statements: string[], params: unknown[][]) {
    let max = 0;
    await db.$client.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off");
      for (const [index, statement] of statements.entries()) {
        if (!statement.includes("heartbeat_runs") || !/^\s*select/i.test(statement)) continue;
        const [result] = (await tx.unsafe(`explain (analyze, format json) ${statement}`, params[index] as never[])) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>;
        const read = rowsReadByTable(result!["QUERY PLAN"][0]!.Plan).get("heartbeat_runs") ?? 0;
        max = Math.max(max, read);
      }
    });
    return max;
  }

  it("checks an issue's execution blocker without reading the company's other runs", async () => {
    const recorded = recordingDb(db);

    await getExecutionBlocker(recorded.db, companyId, issueId);

    expect(recorded.statements.some((statement) => statement.includes("heartbeat_runs"))).toBe(true);
    // The issue has RUNS_PER_ISSUE runs; the company has ISSUES times that.
    expect(await maxRunRowsRead(recorded.statements, recorded.statementParams)).toBeLessThanOrEqual(RUNS_PER_ISSUE * 2);
  });

  it("finds each settle candidate's run by its id", async () => {
    const recorded = recordingDb(db);

    await settleUnrecoverableExecutions(recorded.db);
    expect(recorded.statements.some((statement) => statement.includes('inner join "heartbeat_runs"'))).toBe(true);
    // Settling resolved the holds. Reopen them so the replayed candidate join has rows to join.
    await db.execute(sql`update issue_recovery_actions set status = 'active', outcome = null, resolved_at = null
      where company_id = ${companyId} and status = 'resolved' and outcome = 'blocked'`);

    expect(await maxRunRowsRead(recorded.statements, recorded.statementParams)).toBeLessThanOrEqual(RUNS_PER_ISSUE * 2);
  });

  it("matches run evidence and issue ids exactly as the text comparisons did", async () => {
    const [extra] = (await db.execute(sql`insert into issues (company_id, title, status, priority, assignee_agent_id, responsible_user_id, issue_number, identifier)
      select ${companyId}, 'Edge ' || g, 'in_progress', 'medium', ${agentId}, 'plans-user', 100 + g, 'PLN-' || (100 + g)
      from generate_series(1, 6) g returning id`)) as unknown as Array<{ id: string }>;
    const edge = (await db.execute(sql`select id from issues where company_id = ${companyId} and issue_number > 100 order by issue_number`)) as unknown as Array<{ id: string }>;
    expect(extra).toBeTruthy();
    const [badText, upperText, numberValue, nativeIssue, contextIssue, otherContextIssue] = edge.map((row) => row.id);
    const [someRun] = (await db.execute(sql`select id from heartbeat_runs where company_id = ${companyId} limit 1`)) as unknown as Array<{ id: string }>;
    // Holds whose run evidence is not the text Postgres gives a uuid name no run.
    for (const [issue, runId] of [[badText, sql`'not-a-uuid'::text`], [upperText, sql`upper(${someRun!.id})`], [numberValue, sql`'7'::text`]] as const) {
      await db.execute(sql`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, evidence, next_action)
        values (${companyId}, ${issue}, 'active_run_watchdog', 'active', 'board', 'legacy_execution_requires_reconciliation', 'edge:' || ${issue},
          case when ${issue} = ${numberValue} then jsonb_build_object('runId', 7) else jsonb_build_object('runId', ${runId}) end, 'Reconcile the run.')`);
    }
    await expect(settleUnrecoverableExecutions(db)).resolves.not.toThrow();
    for (const issue of [badText, upperText, numberValue]) {
      const [hold] = (await db.execute(sql`select status from issue_recovery_actions where source_issue_id = ${issue}`)) as unknown as Array<{ status: string }>;
      expect(hold?.status).toBe("active");
      await expect(getExecutionBlocker(db, companyId, issue!)).resolves.not.toBeNull();
    }

    // A run's native issue wins over its context issue; the context counts only without one.
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status, runtime_mode,
        native_issue_id, context_snapshot, runner_profile_json, process_pid, next_event_seq, finished_at)
      values
        (${companyId}, ${agentId}, 'assignment', 'system', 'failed', 'legacy', ${nativeIssue}, jsonb_build_object('issueId', ${otherContextIssue}::text),
          jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local')), ${process.pid}, 1, now()),
        (${companyId}, ${agentId}, 'assignment', 'system', 'failed', 'legacy', null, jsonb_build_object('issueId', ${contextIssue}::text),
          jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local')), ${process.pid}, 1, now())`);
    expect(await getConversationOwnershipBlocker(db, companyId, nativeIssue!)).not.toBeNull();
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssue!)).not.toBeNull();
    expect(await getConversationOwnershipBlocker(db, companyId, otherContextIssue!)).toBeNull();
    expect(await getConversationOwnershipBlocker(db, companyId, nativeIssue!.toUpperCase())).toBeNull();
  });
});
