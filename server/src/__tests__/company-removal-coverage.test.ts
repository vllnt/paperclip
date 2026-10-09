import { randomUUID } from "node:crypto";
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  browserUseBrowsers,
  browserUseRuns,
  browserUseSessions,
  browserUseSettings,
  budgetIncidents,
  budgetPolicies,
  chatEndpoints,
  companies,
  completionContracts,
  connectionGrants,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  secretAccessEvents,
  statusDecisionEffects,
  statusDecisions,
  toolApplications,
  toolConnections,
  workAssessments,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company removal coverage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ForeignKey {
  child: string;
  parent: string;
  action: string;
  columns: string[];
  allNotNull: boolean;
}

interface Violation {
  child: string;
  parent: string;
  columns: string;
  reason: string;
}

const COVERED_PARENTS = new Set(["companies", "agents", "heartbeat_runs"]);

const SEEDED_TABLES = [
  "browser_use_browsers",
  "browser_use_runs",
  "browser_use_sessions",
  "browser_use_settings",
  "budget_incidents",
  "budget_policies",
  "chat_endpoints",
  "completion_contracts",
  "decision_archive_notification_outbox",
  "decision_bundles",
  "decision_queue_items",
  "decision_queues",
  "decision_retention",
  "decision_triage",
  "decision_triage_events",
  "decisions",
  "inbox_dismissals",
  "native_run_finalizations",
  "native_run_results",
  "secret_access_events",
  "status_decision_effects",
  "status_decisions",
  "work_assessments",
  "workspace_runtime_services",
];

function recordTransactionDeletes(transaction: Transaction, statements: string[]): Transaction {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "delete") return value.bind(target);
      return (table: PgTable) => {
        statements.push(getTableName(table));
        return target.delete(table);
      };
    },
  });
}

function recordDeletes(db: Db, statements: string[]): Db {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "transaction") return value.bind(target);
      return (callback: (transaction: Transaction) => Promise<unknown>) =>
        target.transaction((transaction) => callback(recordTransactionDeletes(transaction, statements)));
    },
  });
}

function readForeignKey(row: Record<string, unknown>): ForeignKey | null {
  const { child, parent, action, columns, all_not_null: allNotNull } = row;
  if (typeof child !== "string" || typeof parent !== "string" || typeof action !== "string") return null;
  if (!Array.isArray(columns) || typeof allNotNull !== "boolean") return null;
  return { child, parent, action, columns: columns.map(String), allNotNull };
}

function findViolations(foreignKeys: ForeignKey[], statements: string[]): Violation[] {
  const removedAt = new Map<string, number>();
  statements.forEach((table, index) => {
    if (!removedAt.has(table)) removedAt.set(table, index);
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const key of foreignKeys) {
      if (key.action !== "c" || !key.allNotNull) continue;
      const parentAt = removedAt.get(key.parent);
      if (parentAt === undefined) continue;
      const childAt = removedAt.get(key.child);
      if (childAt === undefined || childAt > parentAt) {
        removedAt.set(key.child, parentAt);
        changed = true;
      }
    }
  }

  const violations: Violation[] = [];
  for (const key of foreignKeys) {
    if (key.action !== "a" && key.action !== "r") continue;
    if (!COVERED_PARENTS.has(key.parent) || key.child === key.parent) continue;
    const parentAt = removedAt.get(key.parent);
    if (parentAt === undefined) continue;
    const childAt = removedAt.get(key.child);
    const columns = key.columns.join(",");
    if (childAt === undefined) {
      violations.push({ child: key.child, parent: key.parent, columns, reason: "its rows are never deleted" });
    } else if (childAt > parentAt || (childAt === parentAt && key.action === "r")) {
      violations.push({ child: key.child, parent: key.parent, columns, reason: "its rows are deleted too late" });
    }
  }
  return violations.sort((a, b) => `${a.child}${a.columns}`.localeCompare(`${b.child}${b.columns}`));
}

describeEmbeddedPostgres("company removal coverage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-removal-coverage-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function countCompanyRows(table: string, companyId: string): Promise<number> {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)} WHERE company_id = ${companyId}`,
    );
    const total = Array.from(rows)[0]?.total;
    return typeof total === "number" ? total : -1;
  }

  async function seedCompanyWithBlockingRows(): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocking rows fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    const [contract] = await db
      .insert(completionContracts)
      .values({
        companyId,
        issueId,
        revision: 1,
        schemaVersion: "1",
        policyVersion: "1",
        risk: "low",
        completionAuthority: "agent",
        incompleteCriteriaPolicy: "block",
        contractJson: {},
        canonicalSha256: "contract-digest",
        createdByActorType: "agent",
        createdByActorId: agentId,
      })
      .returning();
    await db
      .update(heartbeatRuns)
      .set({ nativeIssueId: issueId, completionContractId: contract!.id })
      .where(eq(heartbeatRuns.id, runId));
    const [result] = await db
      .insert(nativeRunResults)
      .values({
        companyId,
        issueId,
        runId,
        completionContractId: contract!.id,
        serverFingerprint: "fingerprint",
        schemaStatus: "valid",
        resultJson: {},
        canonicalSha256: "result-digest",
      })
      .returning();
    const [assessment] = await db
      .insert(workAssessments)
      .values({
        companyId,
        issueId,
        runId,
        contractId: contract!.id,
        resultId: result!.id,
        triggerKind: "run_finished",
        triggerActorCompanyId: companyId,
        priorIssueStatus: "todo",
        priorStatusVersion: 1,
        policyVersion: "1",
        assessmentJson: {},
        inputDigest: "assessment-digest",
      })
      .returning();
    const [statusDecision] = await db
      .insert(statusDecisions)
      .values({
        companyId,
        issueId,
        runId,
        assessmentId: assessment!.id,
        decisionVersion: 1,
        policyVersion: "1",
        fromStatus: "todo",
        toStatus: "done",
        reasonCode: "complete",
        decisionJson: {},
        decisionDigest: "decision-digest",
      })
      .returning();
    await db.insert(statusDecisionEffects).values({
      companyId,
      issueId,
      decisionId: statusDecision!.id,
      ordinal: 0,
      effectKind: "set_status",
      targetType: "issue",
      idempotencyKey: randomUUID(),
      payload: {},
    });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "assessed" });

    const [bundle] = await db
      .insert(decisionBundles)
      .values({
        companyId,
        title: "Bundle",
        summary: "Bundle summary",
        originAgentId: agentId,
        originIssueId: issueId,
        originRunId: runId,
      })
      .returning();
    await db.insert(decisions).values({
      companyId,
      bundleId: bundle!.id,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
      title: "Decision",
      body: "Decision body",
      options: [],
      expiresAt: new Date(now.getTime() + 60_000),
      signedSpec: "signed-spec",
      targetSnapshots: [],
    });

    const [queue] = await db
      .insert(decisionQueues)
      .values({
        companyId,
        key: "queue",
        title: "Queue",
        createdByType: "agent",
        createdByAgentId: agentId,
        createdByRunId: runId,
      })
      .returning();
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId: queue!.id,
      sourceKind: "issue",
      sourceId: issueId,
      addedByType: "agent",
      addedByAgentId: agentId,
      addedByRunId: runId,
    });
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      setByType: "agent",
      setByAgentId: agentId,
      setByRunId: runId,
    });
    await db.insert(decisionTriageEvents).values({
      companyId,
      action: "set",
      actorType: "agent",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      sourceActivityAt: now,
      archivedAt: now,
      archivedByType: "agent",
      archivedByAgentId: agentId,
      archivedByRunId: runId,
    });
    await db.insert(decisionArchiveNotificationOutbox).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      archiveVersion: 1,
      originAgentId: agentId,
      originIssueId: issueId,
    });

    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, name: "Browser", type: "browser_use" })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name: "Browser connection",
        transport: "rest_api",
        uid: randomUUID(),
      })
      .returning();
    const [grant] = await db
      .insert(connectionGrants)
      .values({ companyId, connectionId: connection!.id, kind: "organization" })
      .returning();
    const [session] = await db
      .insert(browserUseSessions)
      .values({ companyId, issueId, agentId, connectionId: connection!.id, grantId: grant!.id })
      .returning();
    await db.insert(browserUseBrowsers).values({
      companyId,
      sessionId: session!.id,
      providerBrowserId: randomUUID(),
    });
    await db.insert(browserUseRuns).values({
      companyId,
      sessionId: session!.id,
      heartbeatRunId: runId,
      invocationId: randomUUID(),
    });
    await db.insert(browserUseSettings).values({ companyId, grantId: grant!.id });

    const [policy] = await db
      .insert(budgetPolicies)
      .values({ companyId, scopeType: "company", scopeId: companyId, windowKind: "calendar_month_utc" })
      .returning();
    await db.insert(budgetIncidents).values({
      companyId,
      policyId: policy!.id,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      windowStart: now,
      windowEnd: new Date(now.getTime() + 60_000),
      thresholdType: "hard",
      amountLimit: 1,
      amountObserved: 2,
    });

    await db.insert(chatEndpoints).values({
      companyId,
      connectionId: connection!.id,
      provider: "slack",
      publicId: randomUUID(),
      assignedAgentId: agentId,
    });
    await db.insert(inboxDismissals).values({ companyId, userId: "user-1", itemKey: "item-1" });
    await db.insert(secretAccessEvents).values({
      companyId,
      provider: "local_encrypted",
      actorType: "agent",
      consumerType: "run",
      consumerId: runId,
      outcome: "success",
    });
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      scopeType: "issue",
      serviceName: "preview",
      status: "running",
      lifecycle: "shared",
      provider: "local_process",
    });

    return companyId;
  }

  it("deletes a company that has a row in every table blocking its runs, agents or company row, and keeps another company's rows", async () => {
    const companyId = await seedCompanyWithBlockingRows();
    const otherCompanyId = await seedCompanyWithBlockingRows();

    for (const table of SEEDED_TABLES) {
      expect(await countCompanyRows(table, companyId), `${table} seeded for the company`).toBe(1);
      expect(await countCompanyRows(table, otherCompanyId), `${table} seeded for the other company`).toBe(1);
    }

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    for (const table of SEEDED_TABLES) {
      expect(await countCompanyRows(table, companyId), `${table} rows of the removed company`).toBe(0);
      expect(await countCompanyRows(table, otherCompanyId), `${table} rows of the other company`).toBe(1);
    }
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("deletes every table that has a blocking foreign key to a company, an agent or a run, before the row it references", async () => {
    const statements: string[] = [];
    await companyService(recordDeletes(db, statements)).remove(randomUUID());

    const rows = await db.execute(sql`
      SELECT child_class.relname AS child, parent_class.relname AS parent, constraint_row.confdeltype AS action,
        (SELECT array_agg(attribute.attname ORDER BY key.position)
           FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum, position)
           JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum) AS columns,
        (SELECT bool_and(attribute.attnotnull)
           FROM unnest(constraint_row.conkey) key(attnum)
           JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum) AS all_not_null
      FROM pg_constraint constraint_row
      JOIN pg_class child_class ON child_class.oid = constraint_row.conrelid
      JOIN pg_class parent_class ON parent_class.oid = constraint_row.confrelid
      JOIN pg_namespace namespace ON namespace.oid = child_class.relnamespace
      WHERE constraint_row.contype = 'f' AND namespace.nspname = 'public'
    `);
    const foreignKeys = Array.from(rows).flatMap((row) => {
      const key = readForeignKey(row);
      return key ? [key] : [];
    });

    expect(statements.at(-1)).toBe("companies");
    expect(foreignKeys.length).toBeGreaterThan(100);
    expect(findViolations(foreignKeys, statements)).toEqual([]);
  });
});
