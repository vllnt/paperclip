import type { Db } from "@paperclipai/db";
import { JUDGE_API_KEY_SECRET_NAME, type JudgeKeyResolver } from "./judge-client.js";
import { secretService } from "./secrets.js";

/**
 * Looks up the company's own gateway key in its secrets. A company without the secret gets
 * `undefined`, so nothing from that company is sent anywhere. Each read is audited as a system
 * access by `consumerId`, so every feature that uses the judge passes its own id.
 */
export function createCompanySecretKeyResolver(db: Db, consumerId = "duplicate-detection"): JudgeKeyResolver {
  const secrets = secretService(db);
  return async (companyId) => {
    const secret = await secrets.getByName(companyId, JUDGE_API_KEY_SECRET_NAME);
    if (!secret) return undefined;
    const value = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId,
        actorType: "system",
        actorId: consumerId,
      },
    });
    return value.trim() || undefined;
  };
}
