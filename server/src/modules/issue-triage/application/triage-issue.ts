import {
  ISSUE_TRIAGE_MAX_MODEL_CALLS,
  ISSUE_TRIAGE_THRESHOLDS,
  type IssueTriage,
  type IssueTriageApplyDecision,
  type IssueTriageCategoryResult,
  type IssueTriageMode,
  type IssueTriageOwner,
  type IssueTriagePriority,
  type IssueTriageSkipReason,
  type IssueTriageDegradedReason,
  type IssueTriageOutcome,
} from "@paperclipai/shared";
import {
  TRIAGE_RUBRIC_VERSION,
  buildTriageRequest,
  createCallBudget,
  judgeOwner,
  parseCategory,
  parsePriority,
  planTriage,
  type TriageIssueFacts,
} from "../domain/policy.js";
import type { TriageModel, TriageModelOutcome, TriageRecordInput, TriageStore, TriageWake } from "./ports.js";

export interface TriageIssueRef {
  id: string;
  companyId: string;
}

export type TriageRunResult =
  | { status: "off" }
  | { status: "not_visible" }
  | { status: "already_triaged" }
  | { status: "recorded"; triage: TriageRecordInput };

export interface TriageLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface TriageIssueDeps {
  store: TriageStore;
  model: TriageModel;
  wake: TriageWake;
  logger: TriageLogger;
}

/**
 * Triage of one new issue. Deterministic rules run first and need no model call. Otherwise one model
 * request carries every question (category, plus priority and owner when the issue has neither), under
 * a per-issue ceiling of `ISSUE_TRIAGE_MAX_MODEL_CALLS` requests. The result is always recorded. In
 * `apply` mode the assignee is set only on an unassigned `todo` issue whose top owner is clear enough,
 * through a conditional write that never replaces an assignee. Priority is never changed.
 */
export function createTriageIssue(deps: TriageIssueDeps) {
  const { store, model, wake, logger } = deps;

  function entry(
    issue: TriageIssueFacts,
    mode: IssueTriageMode,
    outcome: IssueTriageOutcome,
    rest: Partial<Omit<TriageRecordInput, "issueId" | "companyId" | "mode" | "outcome" | "version">> = {},
  ): TriageRecordInput {
    return {
      version: 1,
      issueId: issue.id,
      companyId: issue.companyId,
      mode,
      outcome,
      reason: null,
      modelId: null,
      modelCalls: 0,
      inputHashes: [],
      thresholds: ISSUE_TRIAGE_THRESHOLDS,
      priority: null,
      category: null,
      owner: null,
      ...rest,
    };
  }

  async function recorded(triage: TriageRecordInput): Promise<TriageRunResult> {
    await store.record(triage);
    return { status: "recorded", triage };
  }

  async function skipped(issue: TriageIssueFacts, mode: IssueTriageMode, reason: IssueTriageSkipReason) {
    return recorded(entry(issue, mode, "skipped", { reason }));
  }

  async function degraded(
    issue: TriageIssueFacts,
    mode: IssueTriageMode,
    reason: IssueTriageDegradedReason,
    inputHashes: string[],
    modelCalls: number,
  ) {
    return recorded(entry(issue, mode, "degraded", { reason, inputHashes, modelCalls }));
  }

  return async function triageIssue(ref: TriageIssueRef): Promise<TriageRunResult> {
    const mode = await store.getMode(ref.companyId);
    if (mode === "off") return { status: "off" };
    const issue = await store.loadIssue(ref);
    if (!issue) return { status: "not_visible" };
    if (await store.hasTriage(issue.companyId, issue.id)) return { status: "already_triaged" };

    const plan = planTriage(issue);
    if (plan.skip) return skipped(issue, mode, plan.skip);

    const candidates = plan.askOwner ? await store.listOwnerCandidates(issue.companyId) : [];
    const request = buildTriageRequest(issue, plan, candidates);

    const budget = createCallBudget(ISSUE_TRIAGE_MAX_MODEL_CALLS);
    if (!budget.take()) return degraded(issue, mode, "cap_exceeded", [], 0);
    const outcome: TriageModelOutcome = await model.ask({
      companyId: issue.companyId,
      rubricVersion: TRIAGE_RUBRIC_VERSION,
      state: request.state,
      questions: request.questions,
    });
    if (!outcome.ok) return degraded(issue, mode, outcome.reason, [outcome.inputHash], budget.used());

    const priorityAnswer = outcome.answers.priority;
    const priority: IssueTriagePriority = {
      current: issue.priority,
      suggested: priorityAnswer ? parsePriority(priorityAnswer.choice) : null,
      probabilities: priorityAnswer?.probabilities ? { ...priorityAnswer.probabilities } : null,
    };
    const categoryAnswer = outcome.answers.category;
    const category: IssueTriageCategoryResult = {
      suggested: categoryAnswer ? parseCategory(categoryAnswer.choice) : null,
      probabilities: categoryAnswer?.probabilities ? { ...categoryAnswer.probabilities } : null,
    };

    let owner: IssueTriageOwner | null = null;
    let outcomeKind: IssueTriageOutcome = "suggested";
    if (plan.askOwner) {
      if (request.offered.length === 0) {
        owner = {
          suggestedAgentId: null,
          suggestedAgentName: null,
          probabilities: null,
          topProbability: null,
          margin: null,
          decision: "no_candidates",
          appliedAgentId: null,
          candidateCount: 0,
        };
      } else {
        const answer = outcome.answers.owner;
        const judged = judgeOwner({
          mode,
          issueStatus: issue.status,
          ownerKeys: request.ownerKeys,
          choice: answer?.choice ?? null,
          probabilities: answer?.probabilities ?? null,
        });
        let decision: IssueTriageApplyDecision = judged.decision;
        let appliedAgentId: string | null = null;
        if (decision === "applied" && judged.suggestedAgentId !== null) {
          const assigned = await store.assignIfUnassignedTodo({
            companyId: issue.companyId,
            issueId: issue.id,
            agentId: judged.suggestedAgentId,
          });
          if (assigned.ok) {
            appliedAgentId = judged.suggestedAgentId;
            outcomeKind = "applied";
            try {
              await wake.assigned({
                companyId: issue.companyId,
                issueId: issue.id,
                agentId: judged.suggestedAgentId,
                status: assigned.status,
                statusVersion: assigned.statusVersion,
              });
            } catch (error) {
              logger.warn(
                { issueId: issue.id, err: error instanceof Error ? error.message : String(error) },
                "issue triage assigned an owner but could not wake it",
              );
            }
          } else {
            decision = assigned.reason;
          }
        }
        owner = {
          suggestedAgentId: judged.suggestedAgentId,
          suggestedAgentName:
            request.offered.find((candidate) => candidate.id === judged.suggestedAgentId)?.name ?? null,
          probabilities: judged.probabilities,
          topProbability: judged.topProbability,
          margin: judged.margin,
          decision,
          appliedAgentId,
          candidateCount: request.offered.length,
        };
      }
    }

    return recorded(
      entry(issue, mode, outcomeKind, {
        modelId: outcome.modelId,
        modelCalls: outcome.cached ? 0 : budget.used(),
        inputHashes: [outcome.inputHash],
        priority,
        category,
        owner,
      }),
    );
  };
}

export type TriageIssue = ReturnType<typeof createTriageIssue>;

export function toIssueTriage(entry: TriageRecordInput, id: string, createdAt: string): IssueTriage {
  return { ...entry, id, createdAt };
}
