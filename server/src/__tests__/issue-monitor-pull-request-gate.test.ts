import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createFakeGitHubPullRequestApi } from "./helpers/fake-github-pull-request.js";
import { PULL_REQUEST_WAIT_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.ts";
import { parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import {
  PULL_REQUEST_FINGERPRINT_CONTEXT_KEY,
  MAX_GITHUB_RESPONSE_BYTES,
  PULL_REQUEST_UNCHANGED_SKIP_REASON,
  computeIssuePullRequestFingerprint,
  readPullRequestWaitTarget,
} from "../services/pull-request-wake-gate.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pull request wake gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE = 60_000;
const PULL_REQUEST_URL = "https://github.com/acme/app/pull/7";
const PULL_REQUEST_TARGET = { owner: "acme", repo: "app", number: 7 };

describeEmbeddedPostgres("issue monitor: unchanged pull request gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-wake-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Gate fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(issueRecoveryActions);
        await db.delete(issueComments);
        await db.delete(documentRevisions);
        await db.delete(issueDocuments);
        await db.delete(documents);
        await db.delete(activityLog);
        await db.delete(environmentLeases);
        await db.delete(workspaceRuntimeServices);
        await db.delete(issueWorkProducts);
        await db.delete(issues);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * An agent-owned issue with a linked pull request and a wait the agent armed
   * when its last run finished, by default with `--pull-request` on that pull
   * request. `baseline` seeds that run with the fingerprint it started from
   * (read from the fake GitHub as it is at seed time).
   */
  async function seed(input: {
    linkPullRequest?: boolean;
    /** The monitor's serviceName and pullRequestUrl; `null` is a plain wait. */
    waitTarget?: { serviceName: string | null; pullRequestUrl: string | null } | null;
    baseline?: "unchanged" | "none" | "failed" | "read_after_start";
    baselineFinishedAgoMs?: number;
    baselineWakeReason?: string;
    pullRequestMerged?: boolean;
    maxAttempts?: number;
    monitorAttemptCount?: number;
    timeoutAt?: Date;
  } = {}) {
    const waitTarget = input.waitTarget === undefined
      ? { serviceName: PULL_REQUEST_WAIT_MONITOR_SERVICE_NAME, pullRequestUrl: PULL_REQUEST_URL }
      : input.waitTarget ?? { serviceName: null, pullRequestUrl: null };
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const github = createFakeGitHubPullRequestApi({ owner: "acme", repo: "app", number: 7 });
    if (input.pullRequestMerged) {
      github.state.prState = "closed";
      github.state.merged = true;
    }
    const gateDeps = { fetch: github.fetch, resolveToken: async () => "test-token" };
    const now = Date.now();
    const finishedAt = new Date(now - (input.baselineFinishedAgoMs ?? 10 * MINUTE));
    const nextCheckAt = new Date(now - 5_000);
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Re-check CI and review on the pull request",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: waitTarget.serviceName,
      externalRef: null,
      pullRequestUrl: waitTarget.pullRequestUrl,
      maxAttempts: input.maxAttempts ?? 50,
      recoveryPolicy: "wake_owner",
      ...(input.timeoutAt ? { timeoutAt: input.timeoutAt.toISOString() } : {}),
    };
    const attemptCount = input.monitorAttemptCount ?? 1;

    await db.insert(companies).values({
      id: companyId,
      name: "Gate Co",
      issuePrefix: prefix,
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
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
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
      identifier: `${prefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount,
          notes: monitor.notes,
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: waitTarget.serviceName,
          externalRef: null,
          timeoutAt: input.timeoutAt?.toISOString() ?? null,
          maxAttempts: monitor.maxAttempts,
          recoveryPolicy: "wake_owner",
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: attemptCount,
      monitorNotes: monitor.notes,
      monitorScheduledBy: "assignee",
    });
    if (input.linkPullRequest !== false) {
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
    }

    let baselineRunId: string | null = null;
    const baseline = input.baseline ?? "unchanged";
    if (baseline !== "none") {
      const computed = await computeIssuePullRequestFingerprint(
        db,
        { companyId, issueId, agentId, pullRequest: PULL_REQUEST_TARGET },
        gateDeps,
      );
      if (!computed.ok) throw new Error(`fixture fingerprint failed: ${computed.reason}`);
      const startedAt = new Date(finishedAt.getTime() - MINUTE);
      const computedAt = baseline === "read_after_start"
        ? new Date(startedAt.getTime() + 1_000)
        : new Date(startedAt.getTime() - 1_000);
      baselineRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: baselineRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: baseline === "failed" ? "failed" : "succeeded",
        startedAt,
        finishedAt,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: input.baselineWakeReason ?? "issue_monitor_due",
          [PULL_REQUEST_FINGERPRINT_CONTEXT_KEY]: {
            version: computed.fingerprint.version,
            digest: computed.fingerprint.digest,
            computedAt: computedAt.toISOString(),
          },
        },
      });
    }
    github.calls.length = 0;
    return { companyId, agentId, issueId, github, gateDeps, nextCheckAt, finishedAt, baselineRunId };
  }

  async function wakeRows(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function expectWoke(agentId: string, issueId: string) {
    const rows = await wakeRows(agentId);
    expect(rows.map((row) => row.status)).not.toContain("skipped");
    expect(rows.some((row) => row.reason === "issue_monitor_due")).toBe(true);
    const issue = await readIssue(issueId);
    // A normal trigger consumes the one-shot monitor; the agent re-arms it.
    expect(issue.monitorNextCheckAt).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'source' = 'issue.monitor'`,
    ));
    expect(runs).toHaveLength(1);
    return runs[0]!;
  }

  it("skips the adapter, records a no-change heartbeat and re-arms the monitor when the pull request is unchanged", async () => {
    const fixture = await seed();
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });
    const tickAt = new Date();

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixture.agentId));
    expect(runs.map((run) => run.id)).toEqual([fixture.baselineRunId]);

    const rows = await wakeRows(fixture.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", reason: PULL_REQUEST_UNCHANGED_SKIP_REASON, runId: null });
    expect(rows[0]!.payload).toMatchObject({
      issueId: fixture.issueId,
      heartbeatSkip: {
        outcome: "no_change",
        wakeReason: "issue_monitor_due",
        baselineRunId: fixture.baselineRunId,
        pullRequest: { repo: "acme/app", number: 7, state: "open", checks: "pending", status: "pending" },
      },
    });

    // Re-armed for the same wait the agent chose, with the attempt counted.
    const issue = await readIssue(fixture.issueId);
    const waitMs = fixture.nextCheckAt.getTime() - fixture.finishedAt.getTime();
    expect(issue.monitorNextCheckAt?.getTime()).toBe(tickAt.getTime() + waitMs);
    expect(issue.monitorAttemptCount).toBe(2);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      attemptCount: 2,
      lastTriggeredAt: tickAt.toISOString(),
      notes: "Re-check CI and review on the pull request",
    });

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, fixture.issueId));
    const unchanged = activity.find((row) => row.action === "issue.monitor_pull_request_unchanged");
    expect(unchanged?.details).toMatchObject({
      skipReason: PULL_REQUEST_UNCHANGED_SKIP_REASON,
      baselineRunId: fixture.baselineRunId,
      rescheduledAt: issue.monitorNextCheckAt?.toISOString(),
      source: "scheduled",
    });
    expect(activity.map((row) => row.action)).not.toContain("issue.monitor_triggered");
    expect(fixture.github.calls).toHaveLength(4);
  });

  it.each([
    ["a new commit", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.headSha = "2222222222222222222222222222222222222222";
    }],
    ["a check result", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    }],
    ["a new human comment on the pull request", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.comments += 1;
      state.updatedAt = "2026-04-11T12:05:00Z";
    }],
    ["a new review", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.reviewIds = [...state.reviewIds, 102];
    }],
    ["a merge", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.prState = "closed";
      state.merged = true;
    }],
    ["a close without merge", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.prState = "closed";
    }],
    ["a merge conflict", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.mergeableState = "dirty";
    }],
    ["a base branch update", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    }],
    ["a failing commit status", (state: ReturnType<typeof createFakeGitHubPullRequestApi>["state"]) => {
      state.statusState = "failure";
      state.statuses = [{ context: "ci/build", state: "failure" }];
    }],
  ])("wakes the agent after %s", async (_label, change) => {
    const fixture = await seed();
    change(fixture.github.state);
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    const run = await expectWoke(fixture.agentId, fixture.issueId);
    const recorded = run.contextSnapshot?.[PULL_REQUEST_FINGERPRINT_CONTEXT_KEY] as { digest?: string } | undefined;
    const current = await computeIssuePullRequestFingerprint(
      db,
      { companyId: fixture.companyId, issueId: fixture.issueId, agentId: fixture.agentId, pullRequest: PULL_REQUEST_TARGET },
      fixture.gateDeps,
    );
    expect(current.ok && recorded?.digest).toBe(current.ok ? current.fingerprint.digest : "unreachable");
    // The run stores only what the next comparison reads, never the pull request details.
    expect(Object.keys(recorded ?? {}).sort()).toEqual(["computedAt", "digest", "version"]);
    const [wake] = await wakeRows(fixture.agentId);
    expect(JSON.stringify(wake?.payload)).not.toContain("pullRequests");
  });

  type Fixture = Awaited<ReturnType<typeof seed>>;
  // Each case says whether the gate must have reached GitHub, so a case cannot
  // pass because the gate never ran.
  it.each([
    ["GitHub answers an error", true, (fixture: Fixture) => {
      fixture.github.state.failWithStatus = 502;
      return fixture.gateDeps;
    }],
    ["the company has no GitHub credential", false, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      resolveToken: async () => null,
    })],
    ["the credential cannot be resolved", false, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      resolveToken: async () => {
        throw new Error("managed connection unavailable");
      },
    })],
    ["GitHub is rate limited", true, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      fetch: (async (url: string) => {
        fixture.github.calls.push(String(url));
        return new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) },
        });
      }) as typeof fetch,
    })],
    ["GitHub answers a secondary rate limit", true, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      fetch: (async (url: string) => {
        fixture.github.calls.push(String(url));
        return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
      }) as typeof fetch,
    })],
    ["the review list has more than one page", true, (fixture: Fixture) => {
      fixture.github.state.reviewsHaveNextPage = true;
      return fixture.gateDeps;
    }],
    // The same answers as an unchanged pull request, made larger than the cap.
    ["GitHub sends a body over the size cap", true, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      fetch: (async (url: string, init?: RequestInit) => {
        const response = await fixture.github.fetch(url, init);
        const padded = `${await response.text()}${" ".repeat(MAX_GITHUB_RESPONSE_BYTES)}`;
        return new Response(padded, { status: response.status, headers: response.headers });
      }) as typeof fetch,
    })],
    ["GitHub declares a body over the size cap", true, (fixture: Fixture) => ({
      ...fixture.gateDeps,
      fetch: (async (url: string, init?: RequestInit) => {
        const response = await fixture.github.fetch(url, init);
        const headers = new Headers(response.headers);
        headers.set("content-length", String(MAX_GITHUB_RESPONSE_BYTES + 1));
        return new Response(await response.text(), { status: response.status, headers });
      }) as typeof fetch,
    })],
  ])("fails open and wakes when %s", async (_label, reachesGitHub, deps) => {
    const fixture = await seed();
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: deps(fixture) });

    await heartbeat.tickTimers(new Date());

    const run = await expectWoke(fixture.agentId, fixture.issueId);
    expect(run.contextSnapshot?.[PULL_REQUEST_FINGERPRINT_CONTEXT_KEY]).toBeUndefined();
    if (reachesGitHub) expect(fixture.github.calls.length).toBeGreaterThan(0);
    else expect(fixture.github.calls).toHaveLength(0);
  });

  it("fails open within the budget when GitHub hangs", async () => {
    const fixture = await seed();
    fixture.github.state.hang = true;
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: { ...fixture.gateDeps, budgetMs: 300 } });

    const startedAt = performance.now();
    await heartbeat.tickTimers(new Date());
    const elapsedMs = performance.now() - startedAt;

    await expectWoke(fixture.agentId, fixture.issueId);
    expect(fixture.github.calls.length).toBeGreaterThan(0);
    // The budget plus the tick's own database work, far below one unbounded request.
    expect(elapsedMs).toBeLessThan(300 + 2_500);
  });

  it.each([
    ["429 with retry-after", 429, { "retry-after": "60" }],
    ["403 with retry-after (secondary rate limit)", 403, { "retry-after": "60" }],
    ["403 with no requests left", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }],
  ])("treats %s as a rate limit and stops calling GitHub for that company", async (_label, status, headers) => {
    const fixture = await seed({ baseline: "none" });
    let calls = 0;
    const deps = {
      ...fixture.gateDeps,
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status, headers });
      }) as typeof fetch,
    };
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, agentId: fixture.agentId, pullRequest: PULL_REQUEST_TARGET };

    const first = await computeIssuePullRequestFingerprint(db, input, deps);
    const callsAfterFirst = calls;
    const second = await computeIssuePullRequestFingerprint(db, input, deps);

    expect(first).toMatchObject({ ok: false, reason: "github_rate_limited" });
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(second).toMatchObject({ ok: false, reason: "github_backoff" });
    expect(calls).toBe(callsAfterFirst);
  });

  // A wait without a pull request target behaves exactly as before: the gate
  // never runs, whatever pull request the issue links (the deploy wait after a
  // merge, a lock, another repository).
  it.each([
    ["an open pull request", false],
    ["a merged pull request (a deploy wait)", true],
  ])("wakes a plain wait normally when the issue links %s, without calling GitHub", async (_label, merged) => {
    const fixture = await seed({ waitTarget: null, pullRequestMerged: merged });
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    const run = await expectWoke(fixture.agentId, fixture.issueId);
    expect(fixture.github.calls).toHaveLength(0);
    expect(run.contextSnapshot?.[PULL_REQUEST_FINGERPRINT_CONTEXT_KEY]).toBeUndefined();
  });

  it("wakes a wait that names the pull request service but no URL, without calling GitHub", async () => {
    const fixture = await seed({ waitTarget: { serviceName: PULL_REQUEST_WAIT_MONITOR_SERVICE_NAME, pullRequestUrl: null } });
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    await expectWoke(fixture.agentId, fixture.issueId);
    expect(fixture.github.calls).toHaveLength(0);
  });

  // The policy validator already refuses these, but the gate re-validates what
  // it reads, so no other path can point it at another host or path.
  it.each([
    [undefined],
    [null],
    [""],
    ["https://github.example.com/acme/app/pull/7"],
    ["https://github.com.example.test/acme/app/pull/7"],
    ["http://github.com/acme/app/pull/7"],
    ["https://github.com/acme/../pull/7"],
    ["https://github.com/./app/pull/7"],
    ["https://github.com/acme/app/pull/7/files"],
    ["https://github.com/acme/app/issues/7"],
    ["acme/app#7"],
  ])("finds no pull request target in %j", (pullRequestUrl) => {
    expect(readPullRequestWaitTarget({ pullRequestUrl })).toBeNull();
  });

  it("reads the canonical pull request target", () => {
    expect(readPullRequestWaitTarget({ pullRequestUrl: PULL_REQUEST_URL })).toEqual(PULL_REQUEST_TARGET);
  });

  it("never uses the server's own GitHub token: with only server env tokens it wakes without calling GitHub", async () => {
    const fixture = await seed();
    vi.stubEnv("GITHUB_TOKEN", "server-env-token");
    vi.stubEnv("GH_TOKEN", "server-env-token");
    vi.stubEnv("PAPERCLIP_GITHUB_TOKEN", "server-env-token");
    try {
      // The real credential lookup: no resolveToken stub.
      const heartbeat = heartbeatService(db, { pullRequestWakeGate: { fetch: fixture.github.fetch } });

      await heartbeat.tickTimers(new Date());

      await expectWoke(fixture.agentId, fixture.issueId);
      expect(fixture.github.calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["there is no earlier run to compare with", { baseline: "none" as const }],
    ["the last run failed", { baseline: "failed" as const }],
    ["the fingerprint reached the last run after it started", { baseline: "read_after_start" as const }],
    ["the last run finished more than four hours ago", { baselineFinishedAgoMs: 5 * 60 * MINUTE }],
    ["this is the last attempt a re-arm allows", { maxAttempts: 2 }],
    ["the pull request is already merged", { pullRequestMerged: true }],
    ["another wake (a comment) took over the last run", { baselineWakeReason: "issue_commented" }],
  ])("wakes on an unchanged pull request when %s", async (_label, seedInput) => {
    const fixture = await seed(seedInput);
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    await expectWoke(fixture.agentId, fixture.issueId);
  });

  it("wakes on an unchanged pull request when someone commented on the issue after the last run started", async () => {
    const fixture = await seed();
    await db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorUserId: "board-user",
      body: "Please also update the changelog.",
      createdAt: new Date(fixture.finishedAt.getTime() - 10_000),
    });
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    await expectWoke(fixture.agentId, fixture.issueId);
  });

  it("still skips when the only new issue comment is the agent's own", async () => {
    const fixture = await seed();
    await db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorAgentId: fixture.agentId,
      body: "Waiting for CI.",
      createdAt: new Date(fixture.finishedAt.getTime() - 10_000),
    });
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    const rows = await wakeRows(fixture.agentId);
    expect(rows.map((row) => row.reason)).toEqual([PULL_REQUEST_UNCHANGED_SKIP_REASON]);
  });

  it("does not re-arm over an issue edit made while the pull request was being read", async () => {
    const fixture = await seed();
    const editedNextCheckAt = new Date(Date.now() + 90 * MINUTE);
    const heartbeat = heartbeatService(db, {
      pullRequestWakeGate: {
        ...fixture.gateDeps,
        // The agent (or a person) arms a new wait while the gate reads GitHub.
        resolveToken: async () => {
          await db
            .update(issues)
            .set({ monitorNextCheckAt: editedNextCheckAt, monitorWakeRequestedAt: null })
            .where(eq(issues.id, fixture.issueId));
          return "test-token";
        },
      },
    });

    await heartbeat.tickTimers(new Date());

    const issue = await readIssue(fixture.issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(editedNextCheckAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    const rows = await wakeRows(fixture.agentId);
    expect(rows.map((row) => row.reason)).toEqual([PULL_REQUEST_UNCHANGED_SKIP_REASON]);
  });

  it("never re-arms an unchanged check past the monitor's timeout", async () => {
    const timeoutAt = new Date(Date.now() + 2 * MINUTE);
    const fixture = await seed({ timeoutAt });
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    await heartbeat.tickTimers(new Date());

    const issue = await readIssue(fixture.issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(timeoutAt.toISOString());
  });

  it("always wakes for a person's check-now, even when the pull request is unchanged", async () => {
    const fixture = await seed();
    const heartbeat = heartbeatService(db, { pullRequestWakeGate: fixture.gateDeps });

    const result = await heartbeat.triggerIssueMonitor(fixture.issueId, {
      now: new Date(),
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");
    await expectWoke(fixture.agentId, fixture.issueId);
    expect(fixture.github.calls).toHaveLength(0);
  });
});
