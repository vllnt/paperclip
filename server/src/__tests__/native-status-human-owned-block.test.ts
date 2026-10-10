import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeStatusDecision,
} from "../services/native-runtime/status-arbiter.js";
import { recordNativeFinalizationFailure } from "../services/native-runtime/native-run-finalizer.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native status projection block tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const BOARD_BLOCK: IssueUnblockDescriptor = { owner: "board", action: "Approve the deploy" };
const PERSON_BLOCK: IssueUnblockDescriptor = { owner: { userId: "board-user" }, action: "Sign the form" };
const BLOCKED_AT = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 60_000);

/** The three decisions of the arbiter that the reviewer found to produce `in_progress`. */
const IN_PROGRESS_DECISIONS = [
  "live_continuation_registered",
  "external_chat_response_waiting",
  "completion_evidence_incomplete",
] as const;

function inProgressDecision(reasonCode: string): NativeStatusDecision {
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [],
  };
}

describeEmbeddedPostgres("the native status projection and blocks that wait for a human", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-status-human-block-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** One company, agent and issue with the records that a native run leaves before its status decision. */
  /**
   * One company, agent and issue with the records that a native run leaves before its status
   * decision. With `existing`, only a further run and its records are added to that issue.
   */
  async function seed(
    input: { status: string; descriptor: IssueUnblockDescriptor | null },
    existing?: { companyId: string; agentId: string; issueId: string },
  ) {
    const nonce = randomUUID().slice(0, 8);
    let companyId: string;
    let agentId: string;
    let issueId: string;
    if (existing) {
      ({ companyId, agentId, issueId } = existing);
    } else {
      const [company] = await db
        .insert(companies)
        .values({ name: `Native ${nonce}`, issuePrefix: `NB${nonce.slice(0, 4).toUpperCase()}` })
        .returning();
      companyId = company!.id;
      const [agent] = await db
        .insert(agents)
        .values({ companyId, name: `Agent ${nonce}`, role: "engineer", adapterType: "codex_local", status: "running" })
        .returning();
      agentId = agent!.id;
      const [issue] = await db
        .insert(issues)
        .values({
          companyId,
          title: "Waiting on a human",
          status: input.status,
          priority: "medium",
          assigneeAgentId: agentId,
          workMode: "standard",
          unblockDescriptor: input.descriptor,
          blockedTransitionAt: input.status === "blocked" ? BLOCKED_AT : null,
        })
        .returning();
      issueId = issue!.id;
    }
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      contextSnapshot: { issueId },
      completionContractId: contractId,
      completionContractSha256: `contract:${nonce}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: existing ? 2 : 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "block-v1", criteria: [{ id: "objective", requirement: "block" }] },
      canonicalSha256: `contract:${nonce}`,
      createdByActorType: "system",
      createdByActorId: "native-status-human-block",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${nonce}`,
      schemaStatus: "accepted",
      resultJson: { result: { summary: "block" }, terminal: { runTerminalState: "succeeded" } },
      canonicalSha256: `result:${nonce}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: input.status,
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: {},
      inputDigest: `assessment:${nonce}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });
    return { companyId, agentId, issueId, runId, assessmentId };
  }

  function commit(seeded: Awaited<ReturnType<typeof seed>>, priorStatus: string, decision: NativeStatusDecision) {
    return commitNativeStatusDecision({
      db,
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus,
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision,
    });
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  describe("a board-owned or person-owned block", () => {
    it.each(
      IN_PROGRESS_DECISIONS.flatMap((reasonCode) => [
        [reasonCode, "board", BOARD_BLOCK] as const,
        [reasonCode, "person", PERSON_BLOCK] as const,
      ]),
    )(
      "stays blocked with its descriptor when the arbiter decides in_progress (%s, owned by %s)",
      async (reasonCode, _owner, descriptor) => {
        const seeded = await seed({ status: "blocked", descriptor });

        const committed = await commit(seeded, "blocked", inProgressDecision(reasonCode));

        const after = await readIssue(seeded.issueId);
        expect(after.status).toBe("blocked");
        expect(after.unblockDescriptor).toEqual(descriptor);
        expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
        expect(Number(after.statusVersion)).toBe(0);
        expect(after.lastStatusDecisionId).toBeNull();
        expect(committed.issue.status).toBe("blocked");
        expect(committed.decision.applicationState).toBe("applied");
      },
    );

    it("still records the decision of the run, without a projection effect", async () => {
      const seeded = await seed({ status: "blocked", descriptor: BOARD_BLOCK });

      const committed = await commit(seeded, "blocked", inProgressDecision("live_continuation_registered"));

      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, committed.decision.id));
      expect(decision).toMatchObject({ fromStatus: "blocked", toStatus: "in_progress", applicationState: "applied" });
      const [coordinator] = await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, seeded.runId));
      expect(coordinator).toMatchObject({ phase: "committed", decisionId: committed.decision.id });
      const effects = await db
        .select()
        .from(statusDecisionEffects)
        .where(eq(statusDecisionEffects.decisionId, committed.decision.id));
      expect(effects.map((effect) => effect.effectKind)).not.toContain("issue_status_projection");
    });

    it("logs the skip with the existing issue.status_decision_recorded action and not issue.updated", async () => {
      const seeded = await seed({ status: "blocked", descriptor: BOARD_BLOCK });

      await commit(seeded, "blocked", inProgressDecision("live_continuation_registered"));

      const actions = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.entityId, seeded.issueId), eq(activityLog.entityType, "issue")));
      expect(actions.map((row) => row.action)).toContain("issue.status_decision_recorded");
      expect(actions.map((row) => row.action)).not.toContain("issue.updated");
    });

    it("stays blocked when the arbiter decides done, and the run's decision is still recorded", async () => {
      const seeded = await seed({ status: "blocked", descriptor: BOARD_BLOCK });
      const decision: NativeStatusDecision = {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "done",
        toStatus: "done",
        reasonCode: "completion_evidence_satisfied",
        unblockDescriptor: null,
        effects: [],
      };

      const committed = await commit(seeded, "blocked", decision);

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(after.completedAt).toBeNull();
      expect(committed.decision.applicationState).toBe("applied");
    });

    it("keeps its descriptor when the arbiter decides blocked with another owner", async () => {
      const seeded = await seed({ status: "blocked", descriptor: BOARD_BLOCK });
      const decision: NativeStatusDecision = {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "agent_owned_wait",
        unblockDescriptor: { owner: { agentId: randomUUID() }, action: "Wait for the build" },
        effects: [],
      };

      await commit(seeded, "blocked", decision);

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
      expect(Number(after.statusVersion)).toBe(0);
    });
  });

  describe("a finalization that runs out of retries", () => {
    function exhaust(seeded: Awaited<ReturnType<typeof seed>>) {
      return recordNativeFinalizationFailure({
        db,
        runId: seeded.runId,
        error: new Error("native_finalization_invalid"),
        projectRunStatus: true,
        permanent: true,
      });
    }

    it.each([
      ["the board", BOARD_BLOCK],
      ["a person", PERSON_BLOCK],
    ])("leaves a block owned by %s blocked with its descriptor, and still records the failure", async (_label, descriptor) => {
      const seeded = await seed({ status: "blocked", descriptor });

      const failure = await exhaust(seeded);

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(descriptor);
      expect(after.blockedTransitionAt).toEqual(BLOCKED_AT);
      expect(Number(after.statusVersion)).toBe(0);
      expect(failure.phase).toBe("terminal_failure");
      const [coordinator] = await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, seeded.runId));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_finalization_invalid" });
    });

    it.each([
      ["a block that nobody owns", "blocked"],
      ["an issue in progress", "in_progress"],
    ])("moves %s to in_review, as before", async (_label, status) => {
      const seeded = await seed({ status, descriptor: null });

      await exhaust(seeded);

      expect((await readIssue(seeded.issueId)).status).toBe("in_review");
    });
  });

  describe("a bind_blocker effect", () => {
    function bindBlockerDecision(owner: { agentId: string } | "board", action: string): NativeStatusDecision {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "agent_owned_wait",
        unblockDescriptor: { owner, action },
        effects: [{ kind: "bind_blocker", owner, action }],
      };
    }

    async function wakesFor(companyId: string) {
      return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    }

    it.each([
      ["the board", BOARD_BLOCK],
      ["a person", PERSON_BLOCK],
    ])(
      "leaves a block owned by %s as it is, wakes nobody, and says why in the effect row",
      async (_label, descriptor) => {
        const seeded = await seed({ status: "blocked", descriptor });
        const laundering = { agentId: seeded.agentId };

        const committed = await commit(seeded, "blocked", bindBlockerDecision(laundering, "Wait for the build"));

        const after = await readIssue(seeded.issueId);
        expect(after.status).toBe("blocked");
        expect(after.unblockDescriptor).toEqual(descriptor);
        expect(Number(after.statusVersion)).toBe(0);
        expect(await wakesFor(seeded.companyId), "no wake for the owner that the run asked for").toHaveLength(0);
        const effects = await db
          .select()
          .from(statusDecisionEffects)
          .where(and(eq(statusDecisionEffects.decisionId, committed.decision.id), eq(statusDecisionEffects.effectKind, "bind_blocker")));
        expect(effects).toHaveLength(1);
        expect(effects[0]?.payload).toMatchObject({ heldReason: "human_owned_block", wakeId: null, owner: laundering });
        expect(committed.decision.applicationState).toBe("applied");
      },
    );

    it("does not let the next status projection move the issue, because the descriptor was never changed", async () => {
      const first = await seed({ status: "blocked", descriptor: BOARD_BLOCK });
      await commit(first, "blocked", bindBlockerDecision({ agentId: first.agentId }, "Wait for the build"));
      const second = await seed({ status: "blocked", descriptor: BOARD_BLOCK }, first);

      await commit(second, "blocked", inProgressDecision("live_continuation_registered"));

      const after = await readIssue(first.issueId);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual(BOARD_BLOCK);
    });

    it("still binds a board owner to an issue that is not blocked yet, and wakes nobody", async () => {
      const seeded = await seed({ status: "in_progress", descriptor: null });

      await commit(seeded, "in_progress", bindBlockerDecision("board", "Approve the deploy"));

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("blocked");
      expect(after.unblockDescriptor).toEqual({ owner: "board", action: "Approve the deploy" });
      expect(await wakesFor(seeded.companyId)).toHaveLength(0);
    });

    it("still binds an agent owner, replaces the descriptor of a block that an agent owns, and wakes that agent", async () => {
      const seeded = await seed({ status: "blocked", descriptor: null });
      await db
        .update(issues)
        .set({ unblockDescriptor: { owner: { agentId: seeded.agentId }, action: "Old wait" } })
        .where(eq(issues.id, seeded.issueId));

      await commit(seeded, "blocked", bindBlockerDecision({ agentId: seeded.agentId }, "New wait"));

      expect((await readIssue(seeded.issueId)).unblockDescriptor).toEqual({ owner: { agentId: seeded.agentId }, action: "New wait" });
      expect(await wakesFor(seeded.companyId)).toHaveLength(1);
    });
  });

  describe("every other prior state", () => {
    it("moves a block that the agent owns itself to in_progress and clears the descriptor, as before", async () => {
      const seeded = await seed({ status: "blocked", descriptor: null });
      const own: IssueUnblockDescriptor = { owner: { agentId: randomUUID() }, action: "Wait for the build" };
      await db.update(issues).set({ unblockDescriptor: own }).where(eq(issues.id, seeded.issueId));

      const committed = await commit(seeded, "blocked", inProgressDecision("live_continuation_registered"));

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("in_progress");
      expect(after.unblockDescriptor).toBeNull();
      expect(Number(after.statusVersion)).toBe(1);
      expect(after.lastStatusDecisionId).toBe(committed.decision.id);
    });

    it("moves a block with no descriptor to in_progress, as before", async () => {
      const seeded = await seed({ status: "blocked", descriptor: null });

      await commit(seeded, "blocked", inProgressDecision("live_continuation_registered"));

      expect((await readIssue(seeded.issueId)).status).toBe("in_progress");
    });

    it("projects a status for an issue that is not blocked, as before, with an issue.updated entry", async () => {
      const seeded = await seed({ status: "in_review", descriptor: null });

      const committed = await commit(seeded, "in_review", inProgressDecision("live_continuation_registered"));

      const after = await readIssue(seeded.issueId);
      expect(after.status).toBe("in_progress");
      expect(after.lastStatusDecisionId).toBe(committed.decision.id);
      const actions = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.entityId, seeded.issueId), eq(activityLog.entityType, "issue")));
      expect(actions.map((row) => row.action)).toContain("issue.updated");
    });
  });
});
