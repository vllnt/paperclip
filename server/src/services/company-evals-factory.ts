import type { Db } from "@paperclipai/db";
import { createEvalsModule, type EvalsService, type EvalsSettings } from "../modules/evals/index.js";
import { createJudgeClient, createJudgeUsageStore, readJudgeConfig } from "./judge-client.js";
import { createCompanySecretKeyResolver } from "./judge-key-resolver.js";

/**
 * Wires company evals for the running server. Evals use the one Jev client: each company's own
 * gateway key from its secrets (audited as `evals`), and the daily call cap shared with duplicate
 * detection. Create it once so runs share one answer cache.
 */
export function createCompanyEvals(db: Db, settings: EvalsSettings): EvalsService {
  const config = readJudgeConfig();
  return createEvalsModule({
    db,
    judge: createJudgeClient({
      config,
      usage: createJudgeUsageStore(db, config.dailyCallCap),
      resolveApiKey: createCompanySecretKeyResolver(db, "evals"),
    }),
    settings,
  });
}
