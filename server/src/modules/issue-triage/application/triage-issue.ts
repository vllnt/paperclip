import type { IssueTriageApplyOutcome, IssueTriageProbabilities } from "@paperclipai/shared";
import { groupCandidates, pageGroups } from "../domain/candidates.js";
import { TRIAGE_MAX_MODEL_CALLS, TRIAGE_RUBRIC_VERSION } from "../domain/constants.js";
import { decideOwner, readCategory, readPriority } from "../domain/decision.js";
import {
  CATEGORY_QUESTION,
  CATEGORY_QUESTION_ID,
  PRIORITY_QUESTION,
  PRIORITY_QUESTION_ID,
  ownerQuestion,
  ownerQuestionId,
  type TriageChoiceQuestion,
} from "../domain/questions.js";
import { planTriage } from "../domain/rules.js";
import type { TriageIssueFacts, TriageOwnerPage, TriageRecordDraft } from "../domain/types.js";
import type { IssueTriagePorts, TriageModelFailureReason } from "./ports.js";

export interface TriageRef {
  id: string;
  companyId: string;
}

/**
 * - `off`: the company has not opted in.
 * - `not_visible`: the issue is not readable yet (its transaction is still open); the caller may retry.
 * - `ignored`: a rule leaves the issue alone and no record is written.
 * - `already_recorded`: the issue already has a triage record.
 * - `recorded`: a record was written.
 */
export type TriageOutcome = "off" | "not_visible" | "ignored" | "already_recorded" | "recorded";

const EMPTY_DRAFT: Omit<TriageRecordDraft, "status" | "reason" | "mode"> = {
  suggestedPriority: null,
  category: null,
  suggestedAssigneeAgentId: null,
  probabilities: {},
  applyOutcome: null,
  appliedAt: null,
  modelId: null,
  inputHashes: [],
  modelCalls: 0,
};

/**
 * Builds the use case that triages one new issue: rules first, then at most `TRIAGE_MAX_MODEL_CALLS`
 * model calls, then a stored record and, in `apply` mode, an owner when the router is confident.
 * It never changes a priority and never reassigns. Failures of the model come back as a `degraded`
 * record; a failure of a port throws, and the caller must contain it.
 */
export function createTriageIssue(ports: IssueTriagePorts): (ref: TriageRef) => Promise<TriageOutcome> {
  const now = ports.now ?? (() => new Date());

  async function store(issue: TriageIssueFacts, draft: TriageRecordDraft): Promise<void> {
    const triage = await ports.records.save(issue.companyId, issue.id, draft);
    await ports.activity.recorded({ issue, triage });
  }

  return async (ref) => {
    const mode = await ports.settings.getMode(ref.companyId);
    if (mode === "off") return "off";
    const issue = await ports.issues.load(ref);
    if (!issue) return "not_visible";
    if (await ports.records.find(issue.companyId, issue.id)) return "already_recorded";

    const plan = planTriage(issue);
    if (plan.kind === "ignore") return "ignored";
    if (plan.kind === "skip") {
      await store(issue, { ...EMPTY_DRAFT, status: "skipped", reason: plan.reason, mode });
      return "recorded";
    }
    if (!(await ports.model.isAvailable(issue.companyId))) {
      await store(issue, { ...EMPTY_DRAFT, status: "degraded", reason: "no_key", mode });
      return "recorded";
    }

    const text = ports.text.prepare({ title: issue.title, description: issue.description });
    const groups = plan.askOwner
      ? groupCandidates(await ports.agents.listCandidates(issue.companyId), text)
      : [];
    const ownerPages = pageGroups(groups);
    const callCount = Math.min(TRIAGE_MAX_MODEL_CALLS, Math.max(1, ownerPages.length));

    const answeredPages: TriageOwnerPage[] = [];
    const inputHashes: string[] = [];
    let priority: ReturnType<typeof readPriority> = { value: null, probabilities: undefined };
    let category: ReturnType<typeof readCategory> = { value: null, probabilities: undefined };
    let modelId: string | null = null;
    let failure: TriageModelFailureReason | null = null;

    for (let call = 0; call < callCount && inputHashes.length < TRIAGE_MAX_MODEL_CALLS; call += 1) {
      const questions: Record<string, TriageChoiceQuestion> = {};
      if (call === 0) {
        questions[CATEGORY_QUESTION_ID] = CATEGORY_QUESTION;
        if (plan.askPriority) questions[PRIORITY_QUESTION_ID] = PRIORITY_QUESTION;
      }
      const page = ownerPages[call];
      if (page) questions[ownerQuestionId(call)] = ownerQuestion(page);

      const outcome = await ports.model.ask({
        companyId: issue.companyId,
        rubricVersion: TRIAGE_RUBRIC_VERSION,
        state: { issue: text },
        questions,
      });
      inputHashes.push(outcome.inputHash);
      if (!outcome.ok) {
        failure = outcome.reason;
        break;
      }
      modelId = outcome.modelId;
      if (call === 0) {
        category = readCategory(outcome.answers[CATEGORY_QUESTION_ID]);
        if (plan.askPriority) priority = readPriority(outcome.answers[PRIORITY_QUESTION_ID]);
      }
      const answer = outcome.answers[ownerQuestionId(call)];
      if (page && answer) answeredPages.push({ groups: page, answer });
    }

    const probabilities: IssueTriageProbabilities = {
      ...(priority.probabilities ? { priority: priority.probabilities } : {}),
      ...(category.probabilities ? { category: category.probabilities } : {}),
    };
    const base = {
      mode,
      suggestedPriority: priority.value,
      category: category.value,
      modelId,
      inputHashes,
      modelCalls: inputHashes.length,
    } as const;

    if (failure) {
      await store(issue, {
        ...EMPTY_DRAFT,
        ...base,
        status: "degraded",
        reason: failure,
        probabilities,
        applyOutcome: plan.askOwner ? "no_suggestion" : null,
      });
      return "recorded";
    }

    let suggestedAssigneeAgentId: string | null = null;
    let applyOutcome: IssueTriageApplyOutcome | null = null;
    let appliedAt: Date | null = null;
    if (plan.askOwner) {
      const decision = decideOwner(answeredPages);
      suggestedAssigneeAgentId = decision.suggestedAgentId;
      if (decision.options && decision.options.length > 0) probabilities.owner = decision.options;
      if (decision.blockedBy) {
        applyOutcome = decision.blockedBy;
      } else if (mode !== "apply") {
        applyOutcome = "suggest_mode";
      } else if (issue.status !== "todo" || suggestedAssigneeAgentId === null) {
        applyOutcome = suggestedAssigneeAgentId === null ? "no_suggestion" : "not_unassigned_todo";
      } else {
        const result = await ports.assignment.assignIfUnassignedTodo({
          companyId: issue.companyId,
          issueId: issue.id,
          agentId: suggestedAssigneeAgentId,
        });
        applyOutcome = result.applied ? "applied" : result.reason;
        if (result.applied) appliedAt = now();
      }
    } else {
      applyOutcome = "not_requested";
    }

    await store(issue, {
      ...EMPTY_DRAFT,
      ...base,
      status: "scored",
      reason: null,
      probabilities,
      suggestedAssigneeAgentId,
      applyOutcome,
      appliedAt,
    });
    return "recorded";
  };
}
