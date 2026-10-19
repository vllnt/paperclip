import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentHarnessCooldowns,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  routines,
} from "@paperclipai/db";
import type { TransientRetryPolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-04-20T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const WAKE_REASON = "transient_failure_retry";

describeEmbeddedPostgres("transient retry policy layers", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-transient-retry-policy-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agentHarnessCooldowns);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a failed transient run on an issue that already has one retry
   * scheduled in the last hour, so the per-hour limit is observable.
   */
  async function seed(input: {
    company?: TransientRetryPolicy;
    agent?: TransientRetryPolicy;
    routine?: TransientRetryPolicy;
    issueStatus?: string;
  }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      transientRetryPolicy: input.company ?? {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        ...(input.agent ? { transientRetryPolicy: input.agent } : {}),
      },
      permissions: {},
    });
    let routineId: string | null = null;
    if (input.routine) {
      routineId = randomUUID();
      await db.insert(routines).values({
        id: routineId,
        companyId,
        title: "Routine",
        assigneeAgentId: agentId,
        transientRetryPolicy: input.routine,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry policy fixture",
      status: input.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
      ...(routineId ? { originKind: "routine_execution", originId: routineId } : {}),
    });
    const failureResult = {
      workspaceRestoreFailure: "restore_lock_timeout",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
    // An earlier retry of the same issue, scheduled at NOW, that counts toward the hourly budget.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      scheduledRetryAt: NOW,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId, wakeReason: WAKE_REASON },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "workspace_restore_lock_timeout",
      finishedAt: NOW,
      resultJson: failureResult,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { runId, companyId, agentId, issueId };
  }

  const schedule = (runId: string) => heartbeat.scheduleBoundedRetry(runId, { now: NOW, random: () => 0 });

  async function scheduledDelayMs(runId: string) {
    const result = await schedule(runId);
    expect(result.outcome).toBe("scheduled");
    if (result.outcome !== "scheduled" || !result.run?.scheduledRetryAt) throw new Error("Expected a scheduled retry");
    return result.run.scheduledRetryAt.getTime() - NOW.getTime();
  }

  const BASE_DELAY_MS = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0];

  describe("defaults keep the pre-setting behavior", () => {
    it("does not defer a retry even when one is already scheduled this hour", async () => {
      const { runId } = await seed({});
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });

    it("still schedules a retry for a blocked issue", async () => {
      const { runId } = await seed({ issueStatus: "blocked" });
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });
  });

  describe("most specific layer wins", () => {
    it("company limit defers the retry when nothing overrides it", async () => {
      const { runId } = await seed({ company: { perIssuePerHour: 1 } });
      expect(await scheduledDelayMs(runId)).toBe(HOUR_MS);
    });

    it("agent overrides company (limit lifted back to unlimited)", async () => {
      const { runId } = await seed({ company: { perIssuePerHour: 1 }, agent: { perIssuePerHour: 0 } });
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });

    it("routine overrides agent and company", async () => {
      const { runId } = await seed({
        company: { perIssuePerHour: 5 },
        agent: { perIssuePerHour: 0 },
        routine: { perIssuePerHour: 1 },
      });
      expect(await scheduledDelayMs(runId)).toBe(HOUR_MS);
    });

    it("a wake-type override beats every plain layer, including the routine", async () => {
      const { runId } = await seed({
        company: { wakeTypes: { [WAKE_REASON]: { perIssuePerHour: 0 } } },
        routine: { perIssuePerHour: 1 },
      });
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });

    it("a wake-type override for another wake reason is ignored", async () => {
      const { runId } = await seed({
        company: { perIssuePerHour: 1, wakeTypes: { issue_assigned: { perIssuePerHour: 0 } } },
      });
      expect(await scheduledDelayMs(runId)).toBe(HOUR_MS);
    });

    it("suppresses the retry for a blocked issue when the company opts in", async () => {
      const { runId, issueId } = await seed({ company: { suppressWhenBlocked: true }, issueStatus: "blocked" });
      expect(await schedule(runId)).toMatchObject({ outcome: "not_scheduled", errorCode: "issue_blocked", issueId });
    });

    it("agent can turn blocked-issue suppression back off", async () => {
      const { runId } = await seed({
        company: { suppressWhenBlocked: true },
        agent: { suppressWhenBlocked: false },
        issueStatus: "blocked",
      });
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });

    it("suppression never affects an unblocked issue", async () => {
      const { runId } = await seed({ company: { suppressWhenBlocked: true } });
      expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
    });
  });

  it.each([HOUR_MS / 2, HOUR_MS * 2])(
    "honors both the hourly policy and a harness cooldown of %i ms",
    async (cooldownMs) => {
      const { runId, companyId, agentId } = await seed({ company: { perIssuePerHour: 1 } });
      await db.insert(agentHarnessCooldowns).values({
        companyId,
        agentId,
        targetKey: "codex_local:",
        adapterType: "codex_local",
        reason: "provider_usage_limit",
        cooldownUntil: new Date(NOW.getTime() + cooldownMs),
      });
      expect(await scheduledDelayMs(runId)).toBe(Math.max(HOUR_MS, cooldownMs));
    },
  );

  it("ignores a malformed stored policy instead of failing the retry", async () => {
    const { runId, agentId } = await seed({});
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, transientRetryPolicy: { perIssuePerHour: "lots" } } })
      .where(eq(agents.id, agentId));
    expect(await scheduledDelayMs(runId)).toBe(BASE_DELAY_MS);
  });

  it("reserves distinct hour slots for concurrent predecessors of one issue", async () => {
    const { runId, issueId } = await seed({ company: { perIssuePerHour: 1 } });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "transient_failure"));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const secondId = randomUUID();
    await db.insert(heartbeatRuns).values({ ...source, id: secondId });
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(r => { acquired = r; });
    const gate = new Promise<void>(r => { release = r; });
    const hold = db.transaction(async tx => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      acquired();
      await gate;
    });
    await ready;
    const work = Promise.all([schedule(runId), schedule(secondId)]);
    let blocked = 0;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await db.execute<{ n: number }>(sql`select count(*)::integer as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select id from issues%' and pid <> pg_backend_pid()`);
        blocked = rows[0]?.n ?? 0;
        if (blocked >= 2) break;
        await new Promise(r => setTimeout(r, 25));
      }
    } finally {
      release();
      await hold;
    }
    const results = await work;
    expect(blocked, "both real transactions reached the issue row lock after preflight").toBe(2);
    expect(results.map(r => r.outcome)).toEqual(["scheduled", "scheduled"]);
    const due = results.map(r => r.outcome === "scheduled" ? r.run!.scheduledRetryAt!.getTime() : NaN).sort((a,b) => a-b);
    expect(due[1] - due[0], "limit one permits at most one reservation per rolling hour").toBeGreaterThanOrEqual(HOUR_MS);
  });
});
