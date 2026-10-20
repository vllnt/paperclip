import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createFakeGitHubPullRequestApi } from "./helpers/fake-github-pull-request.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { scheduleIssueWaitMonitor } from "../services/issue-waits.ts";

/**
 * Local simulation, not production data: an agent waits on a pull request with
 * a 10-minute monitor. The pull request stays unchanged for 10 monitor ticks,
 * then gets a new commit before tick 11. The fake agent counts each adapter
 * invocation and, like a real agent, arms the same wait again before it ends.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const WAIT_MS = 10 * 60_000;
const UNCHANGED_TICKS = 10;

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describeEmbeddedPostgres("local simulation: monitor ticks on an unchanged pull request", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-wake-sim-");
    db = createDb(tempDb.connectionString);
    workDir = mkdtempSync(join(tmpdir(), "paperclip-pr-wake-sim-"));
  }, 20_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("counts adapter invocations over 10 unchanged ticks and one change", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const countFile = join(workDir, "invocations.log");
    const goFile = join(workDir, "go");
    writeFileSync(countFile, "");
    const agentScript = [
      `const fs = require("fs");`,
      `fs.appendFileSync(${JSON.stringify(countFile)}, "run\\n");`,
      `console.log("checked the pull request");`,
      `const timer = setInterval(() => {`,
      `  if (fs.existsSync(${JSON.stringify(goFile)})) { fs.rmSync(${JSON.stringify(goFile)}); clearInterval(timer); process.exit(0); }`,
      `}, 20);`,
      `setTimeout(() => process.exit(0), 30000);`,
    ].join("\n");
    const github = createFakeGitHubPullRequestApi({ owner: "acme", repo: "app", number: 7 });
    const heartbeat = heartbeatService(db, {
      pullRequestWakeGate: { fetch: github.fetch, resolveToken: async () => "test-token" },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Simulation Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reviewer Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", agentScript], cwd: workDir },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the fix",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "SIM-1",
      executionPolicy: { mode: "normal", commentRequired: false, stages: [] },
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "acme/app#pull/7",
      title: "Fix the bug",
      url: "https://github.com/acme/app/pull/7",
      status: "active",
      metadata: { repo: "acme/app", number: 7, state: "open" },
    });

    const issuesSvc = issueService(db);
    const armWait = async (nextCheckAt: Date) => {
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      await scheduleIssueWaitMonitor(db, issuesSvc, {
        issue,
        nextCheckAt,
        notes: "Re-check CI and review on the pull request",
        serviceName: "GitHub",
        externalRef: null,
        activity: { actorType: "agent", actorId: agentId, agentId, runId: null, source: "simulation" },
      });
    };
    const invocations = () => readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
    await armWait(new Date(Date.now() - 1_000));

    const ticks: Array<{ tick: number; adapterInvocations: number; githubCalls: number; ms: number }> = [];
    for (let tick = 1; tick <= UNCHANGED_TICKS + 1; tick += 1) {
      if (tick === UNCHANGED_TICKS + 1) github.state.headSha = "2222222222222222222222222222222222222222";
      const due = await db.select({ at: issues.monitorNextCheckAt }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.at ?? null);
      expect(due, `monitor armed before tick ${tick}`).not.toBeNull();
      const tickAt = new Date(due!.getTime() + 1_000);
      const invocationsBefore = invocations();
      const callsBefore = github.calls.length;

      const startedAt = performance.now();
      await heartbeat.tickTimers(tickAt);
      const ms = performance.now() - startedAt;

      const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${agentId} and ${heartbeatRuns.status} in ('queued', 'running')`);
      if (runs.length > 0) {
        // The fake agent runs: wait for its invocation, let it arm the same wait, then let it finish.
        await waitFor(async () => invocations() > invocationsBefore, `adapter invocation on tick ${tick}`);
        await armWait(new Date(tickAt.getTime() + WAIT_MS));
        writeFileSync(goFile, "");
        await waitFor(async () => {
          const active = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
            .where(sql`${heartbeatRuns.agentId} = ${agentId} and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
          return active.length === 0 && !existsSync(goFile);
        }, `run end on tick ${tick}`);
      }
      ticks.push({
        tick,
        adapterInvocations: invocations() - invocationsBefore,
        githubCalls: github.calls.length - callsBefore,
        ms: Math.round(ms),
      });
    }

    const skipTicks = ticks.filter((row) => row.adapterInvocations === 0);
    const summary = {
      scenario: "local simulation: 10 unchanged monitor ticks, then one new commit",
      adapterInvocations: invocations(),
      ticks,
      githubCallsPerTick: ticks.map((row) => row.githubCalls),
      skipPathTickMs: skipTicks.length > 0
        ? { p50: percentile(skipTicks.map((row) => row.ms), 50), p95: percentile(skipTicks.map((row) => row.ms), 95) }
        : null,
    };
    console.log(`PR_WAKE_GATE_SIMULATION ${JSON.stringify(summary)}`);

    // Tick 1 has no earlier run to compare with, ticks 2-10 see an unchanged
    // pull request, and tick 11 sees the new commit.
    expect(ticks.map((row) => row.adapterInvocations)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(invocations()).toBe(2);
  }, 240_000);
});
