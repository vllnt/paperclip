import type { Db } from "@paperclipai/db";
import { createBoundedRunner } from "./duplicate-detection.js";
import { createCompanySecretKeyResolver } from "./duplicate-detection-factory.js";
import { prepareIssueText } from "./duplicate-lexical.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import {
  createJudgeClient,
  createJudgeUsageStore,
  readJudgeConfig,
  type JudgeCache,
} from "./judge-client.js";
import { createIssueTriageModule, type IssueTriageModule, type TriageRef } from "../modules/issue-triage/index.js";
import { logger } from "../middleware/logger.js";

const CONCURRENCY = 3;
const MAX_PENDING = 100;
/** One triage makes at most six model calls, each under the judge timeout. */
const DEADLINE_MS = 60_000;
/** Waits before each retry when the new issue is not visible yet (its transaction is still open). */
const VISIBILITY_RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

export interface IssueTriageService {
  /**
   * Runs after an issue is created, off the request path, through a small bounded queue so bulk
   * creates cannot flood the database or the gateway; excess work is dropped. Never throws.
   */
  triageAfterCreate(ref: TriageRef): Promise<void>;
  find: IssueTriageModule["find"];
}

/**
 * Wires issue triage for the running server on the same judge path as duplicate detection: the
 * company's own gateway key (audited as `issue-triage`), the database-backed daily call cap, the
 * hard timeout and, when passed, the shared answer cache.
 */
export function createIssueTriage(
  db: Db,
  options: { heartbeat: IssueAssignmentWakeupDeps; cache?: JudgeCache },
): IssueTriageService {
  const config = readJudgeConfig();
  const triage = createIssueTriageModule({
    db,
    judge: createJudgeClient({
      config,
      usage: createJudgeUsageStore(db, config.dailyCallCap),
      resolveApiKey: createCompanySecretKeyResolver(db, "issue-triage"),
      cache: options.cache,
    }),
    issues: issueService(db),
    heartbeat: options.heartbeat,
    text: { prepare: prepareIssueText },
  });
  const runBounded = createBoundedRunner(CONCURRENCY, MAX_PENDING, DEADLINE_MS, "issue triage");

  async function run(ref: TriageRef, attempt: number): Promise<void> {
    try {
      if ((await triage.triage(ref)) !== "not_visible") return;
      const delay = VISIBILITY_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) setTimeout(() => void runBounded(() => run(ref, attempt + 1)), delay).unref();
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), issueId: ref.id, companyId: ref.companyId },
        "issue triage after create failed",
      );
    }
  }

  return {
    triageAfterCreate: (ref) => runBounded(() => run(ref, 0)),
    find: triage.find,
  };
}
