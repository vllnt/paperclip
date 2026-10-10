/**
 * The unit cases need no database. The race case needs embedded Postgres, so
 * this file cannot join the fixed `vitest run` list in the Dockerfile.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  isUniqueRecoveryActionConflict,
  issueRecoveryActionService,
} from "../services/issue-recovery-actions.ts";

const SOURCE_INDEX = "issue_recovery_actions_active_source_uq";
const FINGERPRINT_INDEX = "issue_recovery_actions_active_fingerprint_uq";

/** The shape postgres.js produces, wrapped by drizzle's "Failed query" error. */
function wrapped(cause: Record<string, unknown>) {
  return Object.assign(new Error("Failed query: insert into issue_recovery_actions"), { cause });
}

describe("isUniqueRecoveryActionConflict", () => {
  it.each([SOURCE_INDEX, FINGERPRINT_INDEX])("retries a wrapped postgres.js violation of %s", (index) => {
    expect(isUniqueRecoveryActionConflict(wrapped({ code: "23505", constraint_name: index }))).toBe(true);
  });

  it.each([SOURCE_INDEX, FINGERPRINT_INDEX])("still retries a flat violation of %s", (index) => {
    expect(isUniqueRecoveryActionConflict({ code: "23505", constraint: index })).toBe(true);
    expect(isUniqueRecoveryActionConflict({ code: "23505", constraint_name: index })).toBe(true);
    expect(isUniqueRecoveryActionConflict({ code: "23505", message: `duplicate key value violates ${index}` })).toBe(true);
  });

  it("rethrows a unique violation of any other constraint", () => {
    expect(isUniqueRecoveryActionConflict(wrapped({ code: "23505", constraint_name: "issues_open_routine_execution_uq" }))).toBe(false);
    expect(isUniqueRecoveryActionConflict({ code: "23505", constraint: "some_other_uq" })).toBe(false);
  });

  it("rethrows a unique violation that names no constraint", () => {
    expect(isUniqueRecoveryActionConflict(wrapped({ code: "23505" }))).toBe(false);
  });

  it("rethrows other error codes, even when they name the index", () => {
    expect(isUniqueRecoveryActionConflict(wrapped({ code: "23503", constraint_name: SOURCE_INDEX }))).toBe(false);
    expect(isUniqueRecoveryActionConflict(wrapped({ code: "40001" }))).toBe(false);
  });

  it.each([null, undefined, "23505", 23505, new Error("boom")])("rethrows a non-database value: %s", (value) => {
    expect(isUniqueRecoveryActionConflict(value)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery action race test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("two clients racing upsertSourceScoped", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-action-race-");
  }, 240_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fulfils both callers and keeps exactly one active action per issue", async () => {
    const dbA = createDb(tempDb!.connectionString);
    const dbB = createDb(tempDb!.connectionString);
    const companyId = randomUUID();
    await dbA.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const issueIds = Array.from({ length: 12 }, () => randomUUID());
    await dbA.insert(issues).values(issueIds.map((id, index) => ({
      id, companyId, title: `Race ${index}`, status: "in_progress" as const, priority: "medium" as const,
      issueNumber: index + 1, identifier: `RACE-${index + 1}`,
    })));
    const input = (sourceIssueId: string) => ({
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "board" as const,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${sourceIssueId}`,
      evidence: { runId: sourceIssueId },
      nextAction: "Reconcile the stopped run.",
      maxAttempts: 3,
      wakePolicy: null,
    });

    const settled = await Promise.allSettled(issueIds.flatMap((id) => [
      issueRecoveryActionService(dbA).upsertSourceScoped(input(id)),
      issueRecoveryActionService(dbB).upsertSourceScoped(input(id)),
    ]));

    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    for (const id of issueIds) {
      const rows = await dbA.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, id));
      expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    }
  }, 240_000);
});
