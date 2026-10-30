import type { Db } from "@paperclipai/db";
import type { IssueTriage } from "@paperclipai/shared";
import type { JudgeClient } from "../../services/judge-client.js";
import type { IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";
import type { issueService } from "../../services/issues.js";
import { createGuardedAssignment } from "./adapters/assignment.js";
import { createJudgeTriageModel } from "./adapters/judge.js";
import {
  createPostgresTriageActivity,
  createPostgresTriageAgents,
  createPostgresTriageIssues,
  createPostgresTriageRecords,
  createPostgresTriageSettings,
} from "./adapters/postgres.js";
import type { TriageTextPort } from "./application/ports.js";
import { createTriageIssue, type TriageOutcome, type TriageRef } from "./application/triage-issue.js";

export type { TriageOutcome, TriageRef } from "./application/triage-issue.js";
export {
  TRIAGE_MAX_MODEL_CALLS,
  TRIAGE_OWNER_MIN_MARGIN,
  TRIAGE_OWNER_MIN_PROBABILITY,
} from "./domain/constants.js";

export interface IssueTriageModule {
  /** Triages one new issue. Throws only when a database port fails; callers must contain that. */
  triage(ref: TriageRef): Promise<TriageOutcome>;
  /** The stored triage of an issue, or null when none was recorded. */
  find(companyId: string, issueId: string): Promise<IssueTriage | null>;
}

export interface IssueTriageModuleDeps {
  db: Db;
  judge: JudgeClient;
  issues: Pick<ReturnType<typeof issueService>, "update">;
  heartbeat: IssueAssignmentWakeupDeps;
  text: TriageTextPort;
}

/** Composes the Postgres adapters and the decision model behind the triage use case. */
export function createIssueTriageModule(deps: IssueTriageModuleDeps): IssueTriageModule {
  const records = createPostgresTriageRecords(deps.db);
  return {
    triage: createTriageIssue({
      settings: createPostgresTriageSettings(deps.db),
      issues: createPostgresTriageIssues(deps.db),
      agents: createPostgresTriageAgents(deps.db),
      model: createJudgeTriageModel(deps.judge),
      records,
      assignment: createGuardedAssignment({ db: deps.db, issues: deps.issues, heartbeat: deps.heartbeat }),
      activity: createPostgresTriageActivity(deps.db),
      text: deps.text,
    }),
    find: (companyId, issueId) => records.find(companyId, issueId),
  };
}
