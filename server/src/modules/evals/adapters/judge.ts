import type { JudgeClient } from "../../../services/judge-client.js";
import type { EvalJudgePort } from "../application/ports.js";

/**
 * Evals call the one existing Jev client. This adapter only maps its outcome: there is no second
 * judge path. A cache hit and a refusal come back as they are; the use case decides what they cost.
 */
export function createJudgeAdapter(judge: JudgeClient): EvalJudgePort {
  return {
    async ask(request) {
      const outcome = await judge.ask(request);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return {
        ok: true,
        answers: outcome.answers,
        modelId: outcome.modelId,
        cached: outcome.cached,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      };
    },
  };
}
