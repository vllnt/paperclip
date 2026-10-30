import type {
  IssueTriageApplyOutcome,
  IssueTriageCategory,
  IssueTriageMode,
  IssueTriageProbabilities,
  IssueTriageReason,
  IssueTriageStatus,
  IssuePriority,
} from "@paperclipai/shared";

/** What triage needs to know about a new issue. */
export interface TriageIssueFacts {
  id: string;
  companyId: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originKind: string;
  hidden: boolean;
  title: string;
  description: string | null;
}

/** An agent that could take the issue. */
export interface TriageCandidateAgent {
  id: string;
  role: string;
  title: string | null;
  /** Open issues the agent holds now; breaks ties inside a group of look-alike agents. */
  openIssues: number;
}

/** Agents that share a role and title. They are one option for the model. */
export interface TriageCandidateGroup {
  /** The option key the model sees. */
  key: string;
  role: string;
  title: string | null;
  /** The least loaded agent of the group. */
  agentId: string;
  size: number;
}

/** The choice answer of one model question, as the triage code reads it. */
export interface TriageChoiceAnswer {
  choice: string | null;
  probabilities: Readonly<Record<string, number>> | null;
  abstained: boolean;
}

/** One model call that asked for one page of owner options. */
export interface TriageOwnerPage {
  groups: readonly TriageCandidateGroup[];
  answer: TriageChoiceAnswer;
}

export interface TriageOwnerDecision {
  /** The agent to suggest, or null when the model preferred "no fit" or gave nothing. */
  suggestedAgentId: string | null;
  options: IssueTriageProbabilities["owner"];
  /** Why the suggestion may not be applied; null when it may. */
  blockedBy: Exclude<
    IssueTriageApplyOutcome,
    "applied" | "suggest_mode" | "not_requested" | "not_unassigned_todo" | "owner_unavailable"
  > | null;
}

/** The record the module stores for one issue. */
export interface TriageRecordDraft {
  status: IssueTriageStatus;
  reason: IssueTriageReason | null;
  mode: Exclude<IssueTriageMode, "off">;
  suggestedPriority: IssuePriority | null;
  category: IssueTriageCategory | null;
  suggestedAssigneeAgentId: string | null;
  probabilities: IssueTriageProbabilities;
  applyOutcome: IssueTriageApplyOutcome | null;
  appliedAt: Date | null;
  modelId: string | null;
  inputHashes: string[];
  modelCalls: number;
}
