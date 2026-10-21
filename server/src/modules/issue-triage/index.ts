import type { Db } from "@paperclipai/db";
import type { IssueTriagePage } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { createBoundedRunner } from "../../services/duplicate-detection.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "../../services/issue-assignment-wakeup.js";
import type { JudgeClient } from "../../services/judge-client.js";
import { createJudgeTriageModel } from "./adapters/judge.js";
import { TRIAGE_ACTOR_ID, createPostgresTriageStore } from "./adapters/postgres.js";
import { createListTriage } from "./application/list-triage.js";
import { createTriageIssue, type TriageIssueRef } from "./application/triage-issue.js";
import type { TriageWake } from "./application/ports.js";

export { ISSUE_TRIAGE_ACTIVITY_ACTION } from "@paperclipai/shared";
export type { TriageIssueRef } from "./application/triage-issue.js";

const AFTER_CREATE_CONCURRENCY = 3;
const AFTER_CREATE_MAX_PENDING = 100;
const AFTER_CREATE_DEADLINE_MS = 30_000;
/** The create transaction may still be open when the event fires, so a missing issue is retried. */
const VISIBILITY_RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

export interface IssueTriageService {
  /** Off the request path, bounded, never throws. Excess work is dropped, never queued without bound. */
  checkAfterCreate(ref: TriageIssueRef): Promise<void>;
  list(input: {
    companyId: string;
    issueId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ ok: true; page: IssueTriagePage } | { ok: false; error: "invalid_cursor" }>;
}

/**
 * Issue triage for the running server: scores each new issue with the shared judge client and
 * records a suggested priority, category and owner. In `apply` mode it also fills an empty
 * assignee of a `todo` issue and wakes that agent. Create it once.
 */
export function createIssueTriage(deps: {
  db: Db;
  judge: JudgeClient;
  heartbeat: IssueAssignmentWakeupDeps;
  retryDelaysMs?: readonly number[];
}): IssueTriageService {
  const store = createPostgresTriageStore(deps.db);
  const wake: TriageWake = {
    async assigned(input) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        assignmentEvent: true,
        issue: {
          id: input.issueId,
          assigneeAgentId: input.agentId,
          status: input.status,
          statusVersion: input.statusVersion,
        },
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "issue.triage",
        requestedByActorType: "system",
        requestedByActorId: TRIAGE_ACTOR_ID,
        rethrowOnError: true,
      });
    },
  };
  const triageIssue = createTriageIssue({ store, model: createJudgeTriageModel(deps.judge), wake, logger });
  const listTriage = createListTriage({ store });
  const runBounded = createBoundedRunner(
    AFTER_CREATE_CONCURRENCY,
    AFTER_CREATE_MAX_PENDING,
    AFTER_CREATE_DEADLINE_MS,
    "issue triage",
  );
  const retryDelays = deps.retryDelaysMs ?? VISIBILITY_RETRY_DELAYS_MS;

  async function checkNow(ref: TriageIssueRef, attempt: number): Promise<void> {
    try {
      const result = await triageIssue(ref);
      if (result.status !== "not_visible") return;
      const delay = retryDelays[attempt];
      if (delay !== undefined) {
        setTimeout(() => void runBounded(() => checkNow(ref, attempt + 1)), delay).unref();
      }
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), issueId: ref.id, companyId: ref.companyId },
        "issue triage failed",
      );
    }
  }

  return {
    checkAfterCreate(ref) {
      return runBounded(() => checkNow(ref, 0));
    },
    list: listTriage,
  };
}
