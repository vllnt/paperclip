import type { IssueTriage, IssueTriageDegradedReason, IssueTriageMode } from "@paperclipai/shared";
import type { OwnerCandidate, TriageIssueFacts, TriageQuestion, TriageStateValue } from "../domain/policy.js";

export interface TriageModelRequest {
  companyId: string;
  rubricVersion: string;
  state: { [key: string]: TriageStateValue };
  questions: Readonly<Record<string, TriageQuestion>>;
}

export interface TriageModelAnswer {
  /** Null when the model abstained or named an option that was not offered. */
  choice: string | null;
  probabilities: Readonly<Record<string, number>> | null;
}

export type TriageModelOutcome =
  | {
      ok: true;
      answers: Readonly<Record<string, TriageModelAnswer>>;
      modelId: string;
      inputHash: string;
      cached: boolean;
    }
  | { ok: false; reason: IssueTriageDegradedReason; inputHash: string };

/** One request to the decision model. Never throws: a failure comes back as `{ ok: false }`. */
export interface TriageModel {
  ask(request: TriageModelRequest): Promise<TriageModelOutcome>;
}

export type TriageRecordInput = Omit<IssueTriage, "id" | "createdAt">;

export type AssignOutcome =
  | { ok: true; status: string; statusVersion: number }
  | { ok: false; reason: "assignee_changed" | "not_assignable" };

export interface TriageStore {
  getMode(companyId: string): Promise<IssueTriageMode>;
  loadIssue(ref: { id: string; companyId: string }): Promise<TriageIssueFacts | null>;
  hasTriage(companyId: string, issueId: string): Promise<boolean>;
  /** Agents of this company that can be woken: not paused, not terminated, not pending approval. */
  listOwnerCandidates(companyId: string): Promise<OwnerCandidate[]>;
  /** Sets the assignee only if the issue is still an unassigned `todo`. Never reassigns. */
  assignIfUnassignedTodo(input: { companyId: string; issueId: string; agentId: string }): Promise<AssignOutcome>;
  record(entry: TriageRecordInput): Promise<void>;
  /** Newest first, strictly after the cursor position. */
  listRecords(input: {
    companyId: string;
    issueId: string;
    limit: number;
    after: TriageCursor | null;
  }): Promise<TriageRow[]>;
}

export interface TriageCursor {
  createdAt: Date;
  id: string;
}

export interface TriageRow {
  id: string;
  createdAt: Date;
  entry: TriageRecordInput;
}

/** Wakes the agent that the router just assigned. */
export interface TriageWake {
  assigned(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    status: string;
    statusVersion: number;
  }): Promise<void>;
}
