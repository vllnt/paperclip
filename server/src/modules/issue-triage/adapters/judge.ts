import type { JudgeClient } from "../../../services/judge-client.js";
import type { TriageModelPort } from "../application/ports.js";

/**
 * Adapts the shared decision-model client to the triage port. Every triage question is a choice
 * question; any other answer type would be a client bug and reads as no answer.
 */
export function createJudgeTriageModel(judge: JudgeClient): TriageModelPort {
  return {
    isAvailable: (companyId) => judge.isAvailable(companyId),
    async ask(request) {
      const outcome = await judge.ask({
        companyId: request.companyId,
        rubricVersion: request.rubricVersion,
        state: request.state,
        questions: request.questions,
      });
      if (!outcome.ok) return outcome;
      const answers: Record<string, { choice: string | null; probabilities: Readonly<Record<string, number>> | null; abstained: boolean }> = {};
      for (const [id, answer] of Object.entries(outcome.answers)) {
        if (answer.type !== "choice") {
          return { ok: false, reason: "error", inputHash: outcome.inputHash };
        }
        answers[id] = { choice: answer.choice, probabilities: answer.probabilities, abstained: answer.abstained };
      }
      return { ok: true, modelId: outcome.modelId, inputHash: outcome.inputHash, cached: outcome.cached, answers };
    },
  };
}
