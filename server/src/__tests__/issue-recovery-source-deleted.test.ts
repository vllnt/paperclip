/**
 * A recovery action must not be inserted for a source issue that is deleted
 * concurrently (for example a routine issue removed after its wake failed).
 * The insert used to fail with the FK violation
 * `issue_recovery_actions_source_issue_id_issues_id_fk`.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import {
  IssueRecoverySourceMissingError,
  issueRecoveryActionService,
} from "../services/issue-recovery-actions.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery source tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "23503") return true;
  }
  return false;
}

function upsertInput(companyId: string, issueId: string) {
  return {
    companyId,
    sourceIssueId: issueId,
    kind: "missing_disposition" as const,
    ownerType: "board" as const,
    cause: "test_cause",
    fingerprint: `test:${issueId}`,
    nextAction: "Board operator: inspect the issue.",
  };
}

describe("recovery-action insert on a plain connection", () => {
  it("reports a source deleted between its lock and its insert as missing, not as an FK violation", async () => {
    // On a plain connection the lock ends with its statement, so a delete can still win before the insert.
    const fkViolation = Object.assign(new Error("Failed query: insert into issue_recovery_actions"), {
      cause: { code: "23503", constraint_name: "issue_recovery_actions_source_issue_id_issues_id_fk" },
    });
    const selectQuery = (rows: unknown[]) => ({
      from() { return this; },
      where() { return this; },
      orderBy() { return this; },
      limit: async () => rows,
      for: async () => rows,
    });
    const selectResults: unknown[][] = [[], [{ id: "source-1" }]];
    const fakeDb = {
      select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
      insert: vi.fn(() => ({ values: () => ({ returning: async () => { throw fkViolation; } }) })),
    };

    const error = await issueRecoveryActionService(fakeDb as never)
      .upsertSourceScoped(upsertInput("company-1", "source-1"))
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(IssueRecoverySourceMissingError);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

describeEmbeddedPostgres("recovery for a source issue deleted concurrently", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const openDeletes: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-source-deleted-");
    db = createDb(tempDb.connectionString);
  }, 240_000);

  afterEach(async () => {
    // A failed test must not leave its delete open: cleanup would wait on that row lock.
    for (const commit of openDeletes.splice(0)) await commit();
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A `todo` issue assigned to a paused agent: the stranded sweep escalates it with a recovery action. */
  async function seedStrandedIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      requireBoardApprovalForNewAgents: false,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "paused",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "routine run",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  /** Deletes the issue in a transaction that stays open until `commit` is called. */
  async function holdUncommittedDelete(issueId: string) {
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let deleted!: () => void;
    const deletedSignal = new Promise<void>((resolve) => { deleted = resolve; });
    const done = db.transaction(async (tx) => {
      await tx.delete(issues).where(eq(issues.id, issueId));
      deleted();
      await committed;
    });
    await deletedSignal;
    const commitAndWait = async () => { commit(); await done; };
    openDeletes.push(commitAndWait);
    return { commit: commitAndWait };
  }

  /** Resolves once some backend waits on a row lock (here: the issue row the open delete holds). */
  async function waitForLockWaiter() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `);
      if (Number(row?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no backend waited on the deleted issue row");
  }

  it("the stranded sweep skips an issue deleted while it was escalating it, instead of failing", async () => {
    const { issueId } = await seedStrandedIssue();
    const deletion = await holdUncommittedDelete(issueId);

    // The sweep still sees the issue (the delete is not committed) and reaches its recovery-action write.
    const sweep = heartbeatService(db).reconcileStrandedAssignedIssues();
    await waitForLockWaiter();
    await deletion.commit();
    const result = await sweep;

    expect(result.failed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
  });

  it("the recovery-action insert reports the missing source, not an FK violation", async () => {
    const { companyId, issueId } = await seedStrandedIssue();
    const deletion = await holdUncommittedDelete(issueId);

    const outcome = issueRecoveryActionService(db)
      .upsertSourceScoped(upsertInput(companyId, issueId))
      .then(() => null, (error: unknown) => error);
    await waitForLockWaiter();
    await deletion.commit();
    const error = await outcome;

    expect(isForeignKeyViolation(error)).toBe(false);
    expect(error).toBeInstanceOf(IssueRecoverySourceMissingError);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
  });

  it("a caller's transaction stays usable after the insert finds the source gone", async () => {
    const { companyId, issueId } = await seedStrandedIssue();
    await db.delete(issues).where(eq(issues.id, issueId));

    const companyName = await db.transaction(async (tx) => {
      const error = await issueRecoveryActionService(tx as unknown as Db)
        .upsertSourceScoped(upsertInput(companyId, issueId))
        .then(() => null, (caught: unknown) => caught);
      expect(isForeignKeyViolation(error)).toBe(false);
      expect(error).toBeInstanceOf(IssueRecoverySourceMissingError);
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      return company?.name ?? null;
    });

    expect(companyName).toBe("Paperclip");
  });
});
