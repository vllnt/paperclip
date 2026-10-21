import {
  predicateValue,
  type CompanyEvalAnswer,
  type CompanyEvalRunMode,
  type CompanyEvalStatus,
} from "@paperclipai/shared";

/** An agent sees an eval only while it is published at a version. */
export function isVisibleToAgents(evalRow: { status: CompanyEvalStatus; publishedVersionId: string | null }): boolean {
  return evalRow.status === "published" && evalRow.publishedVersionId !== null;
}

/**
 * A run is `live` only when it runs the published version of a published eval and the caller did
 * not ask for `try_it`. Every other run is a board experiment and stays out of the default stats.
 */
export function resolveRunMode(input: {
  evalStatus: CompanyEvalStatus;
  publishedVersionId: string | null;
  runVersionId: string;
  requestedMode: "try_it" | undefined;
}): CompanyEvalRunMode {
  if (input.requestedMode === "try_it") return "try_it";
  if (input.evalStatus !== "published") return "try_it";
  return input.publishedVersionId === input.runVersionId ? "live" : "try_it";
}

/** The date after which the stored input is cleared; null when inputs are not stored. */
export function inputExpiry(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/** The answer shapes that the judge returns, before the predicate `value` rule is applied. */
export type JudgeAnswerShape =
  | { type: "predicate"; probability: number | null; abstained: boolean }
  | {
      type: "choice";
      choice: string | null;
      probabilities: Readonly<Record<string, number>> | null;
      confidence: number | null;
      abstained: boolean;
    }
  | { type: "score"; score: number | null; confidence: number | null; abstained: boolean };

/** Adds `value` to predicate answers by one rule: true at P >= 0.5, false below, null on abstain. */
export function toRunAnswers(answers: Readonly<Record<string, JudgeAnswerShape>>): Record<string, CompanyEvalAnswer> {
  const result: Record<string, CompanyEvalAnswer> = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer.type === "predicate") {
      result[questionId] = {
        type: "predicate",
        probability: answer.probability,
        value: predicateValue(answer.probability, answer.abstained),
        abstained: answer.abstained,
      };
    } else if (answer.type === "choice") {
      result[questionId] = {
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities ? { ...answer.probabilities } : null,
        confidence: answer.confidence,
        abstained: answer.abstained,
      };
    } else {
      result[questionId] = { ...answer };
    }
  }
  return result;
}

export function anyAnswerAbstained(answers: Readonly<Record<string, { abstained: boolean }>>): boolean {
  return Object.values(answers).some((answer) => answer.abstained);
}

/** The key of one feedback author, unique per run and question. */
export function feedbackAuthorKey(author: { type: "agent"; agentId: string } | { type: "user"; userId: string }): string {
  return author.type === "agent" ? `agent:${author.agentId}` : `user:${author.userId}`;
}
