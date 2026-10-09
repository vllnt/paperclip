import type { Db } from "@paperclipai/db";
import { duplicateDetectionService, type DuplicateDetectionService } from "./duplicate-detection.js";
import { issueService } from "./issues.js";
import {
  JUDGE_API_KEY_SECRET_NAME,
  createJudgeClient,
  createJudgeUsageStore,
  readJudgeConfig,
  type JudgeKeyResolver,
} from "./judge-client.js";
import { secretService } from "./secrets.js";

/**
 * Looks up the company's own gateway key in its secrets. A company without the secret gets
 * `undefined`, so its issue text is never sent anywhere. Each read is audited as a system access.
 */
export function createCompanySecretKeyResolver(db: Db): JudgeKeyResolver {
  const secrets = secretService(db);
  return async (companyId) => {
    const secret = await secrets.getByName(companyId, JUDGE_API_KEY_SECRET_NAME);
    if (!secret) return undefined;
    const value = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "duplicate-detection",
        actorType: "system",
        actorId: "duplicate-detection",
      },
    });
    return value.trim() || undefined;
  };
}

/**
 * Wires duplicate detection for the running server: each company's own gateway key from its secrets,
 * the daily cap backed by the database, and system comments posted through the issue service.
 * Create it once so the pre-create check and the after-create check share one answer cache.
 */
export function createDuplicateDetection(db: Db): DuplicateDetectionService {
  const config = readJudgeConfig();
  const issues = issueService(db);
  return duplicateDetectionService({
    db,
    judge: createJudgeClient({
      config,
      usage: createJudgeUsageStore(db, config.dailyCallCap),
      resolveApiKey: createCompanySecretKeyResolver(db),
    }),
    postSystemComment: (issueId, body, tx) => issues.addComment(issueId, body, {}, { authorType: "system" }, tx),
  });
}
