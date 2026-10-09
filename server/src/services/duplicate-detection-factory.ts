import type { Db } from "@paperclipai/db";
import { duplicateDetectionService, type DuplicateDetectionService } from "./duplicate-detection.js";
import { issueService } from "./issues.js";
import { createJudgeClient, createJudgeUsageStore, readJudgeConfig } from "./judge-client.js";

/**
 * Wires duplicate detection for the running server: judge settings from the environment, the daily
 * cap backed by the database, and system comments posted through the issue service. Create it once
 * so the pre-create check and the after-create check share one answer cache.
 */
export function createDuplicateDetection(db: Db): DuplicateDetectionService {
  const config = readJudgeConfig();
  const issues = issueService(db);
  return duplicateDetectionService({
    db,
    judge: createJudgeClient({ config, usage: createJudgeUsageStore(db, config.dailyCallCap) }),
    postSystemComment: (issueId, body, tx) => issues.addComment(issueId, body, {}, { authorType: "system" }, tx),
  });
}
