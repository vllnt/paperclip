import type { JudgeClient } from "../../../services/judge-client.js";
import type { TriageModel, TriageModelAnswer } from "../application/ports.js";

/** Asks the shared judge client (the Jev decision model behind the AI Gateway) the triage questions. */
export function createJudgeTriageModel(judge: JudgeClient): TriageModel {
  return {
    async ask(request) {
      const outcome = await judge.ask({
        companyId: request.companyId,
        rubricVersion: request.rubricVersion,
        state: request.state,
        questions: request.questions,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason, inputHash: outcome.inputHash };
      const answers: Record<string, TriageModelAnswer> = {};
      for (const [id, answer] of Object.entries(outcome.answers)) {
        if (answer.type !== "choice") continue;
        answers[id] = {
          choice: answer.abstained ? null : answer.choice,
          probabilities: answer.probabilities,
        };
      }
      return { ok: true, answers, modelId: outcome.modelId, inputHash: outcome.inputHash, cached: outcome.cached };
    },
  };
}
