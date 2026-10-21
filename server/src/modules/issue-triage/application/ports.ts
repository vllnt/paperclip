import type { IssueTriage, IssueTriageMode } from "@paperclipai/shared";
import type { TriageChoiceQuestion } from "../domain/questions.js";
import type {
  TriageCandidateAgent,
  TriageChoiceAnswer,
  TriageIssueFacts,
  TriageRecordDraft,
} from "../domain/types.js";

export interface TriageModelRequest {
  companyId: string;
  rubricVersion: string;
  state: { issue: { title: string; description: string } };
  questions: Readonly<Record<string, TriageChoiceQuestion>>;
}

export type TriageModelFailureReason = "no_key" | "cap_exceeded" | "timeout" | "error";

export type TriageModelOutcome =
  | {
      ok: true;
      modelId: string;
      inputHash: string;
      cached: boolean;
      answers: Readonly<Record<string, TriageChoiceAnswer>>;
    }
  | { ok: false; reason: TriageModelFailureReason; inputHash: string };

/** The decision model. `ask` never throws: a failure comes back as `{ ok: false }`. */
export interface TriageModelPort {
  /** True when the company has a usable key. Resolves false on any lookup failure. */
  isAvailable(companyId: string): Promise<boolean>;
  ask(request: TriageModelRequest): Promise<TriageModelOutcome>;
}

export interface TriageSettingsPort {
  getMode(companyId: string): Promise<IssueTriageMode>;
}

export interface TriageIssuePort {
  /** Loads the issue under its company; null when it does not exist or is not visible yet. */
  load(ref: { id: string; companyId: string }): Promise<TriageIssueFacts | null>;
}

export interface TriageAgentsPort {
  /** Agents of the company that can take work: not paused, not terminated, not awaiting approval. */
  listCandidates(companyId: string): Promise<TriageCandidateAgent[]>;
}

export interface TriageRecordPort {
  find(companyId: string, issueId: string): Promise<IssueTriage | null>;
  /** Stores the record for the issue, replacing an earlier one. */
  save(companyId: string, issueId: string, draft: TriageRecordDraft): Promise<IssueTriage>;
}

export type TriageAssignmentResult =
  | { applied: true }
  | { applied: false; reason: "not_unassigned_todo" | "owner_unavailable" };

export interface TriageAssignmentPort {
  /**
   * Sets the assignee only when the issue is still an unassigned `todo` of the company and the agent
   * can still take work, checked under the issue lock. Wakes the new assignee and logs the change.
   */
  assignIfUnassignedTodo(input: { companyId: string; issueId: string; agentId: string }): Promise<TriageAssignmentResult>;
}

export interface TriageActivityPort {
  recorded(input: { issue: TriageIssueFacts; triage: IssueTriage }): Promise<void>;
}

export interface TriageTextPort {
  /** Redacts secret-like text and cuts the text to what may be sent. */
  prepare(input: { title: string; description: string | null }): { title: string; description: string };
}

export interface IssueTriagePorts {
  settings: TriageSettingsPort;
  issues: TriageIssuePort;
  agents: TriageAgentsPort;
  model: TriageModelPort;
  records: TriageRecordPort;
  assignment: TriageAssignmentPort;
  activity: TriageActivityPort;
  text: TriageTextPort;
  now?: () => Date;
}
