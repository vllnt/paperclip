import type {
  DuplicateDegradedReason,
  DuplicateDetectionMode,
  DuplicatePairVerdict,
  FindSimilarIssuesResult,
} from "@paperclipai/shared";
import {
  hashJudgeInput,
  type JudgeAnswer,
  type JudgeClient,
  type JudgeFailureReason,
  type JudgeQuestion,
  type JudgeState,
} from "./judge-client.js";
import {
  isExactDuplicate,
  isTooShortForModel,
  lexicalScore,
  normalizeIssueText,
  relationWeight,
  type IssueText,
} from "./duplicate-lexical.js";

/** P(same outcome) at or above this posts a comment. Conservative until calibration says otherwise. */
export const DUPLICATE_ALERT_THRESHOLD = 0.9;
/** P(same outcome) at or below this is a confident "different". Between the two the model abstains. */
export const DUPLICATE_DISTINCT_THRESHOLD = 0.3;
/** An abstained pair at or above this still deserves a look before creating another issue. */
export const DUPLICATE_REVIEW_THRESHOLD = 0.6;
/** Lexical-only candidates at or above this are worth a look when the model is unavailable. */
export const DUPLICATE_LEXICAL_REVIEW_THRESHOLD = 0.85;
export const DUPLICATE_CANDIDATE_LIMIT = 5;
export const SAME_OUTCOME_RUBRIC_VERSION = "same-outcome-1";

const SAME_OUTCOME_QUESTIONS: Readonly<Record<string, JudgeQuestion>> = {
  same_outcome: {
    type: "predicate",
    instructions:
      "Do the new issue and the existing issue ask for the same result, so that completing one would fully complete the other? " +
      "Issues that only share a topic, a component, a parent, or part of the same scope are not the same outcome.",
    whenTrue: "Both issues request the same deliverable; finishing either one leaves nothing for the other.",
    whenFalse: "The issues differ in deliverable or scope, or one covers only part of the other.",
    abstainBand: [DUPLICATE_DISTINCT_THRESHOLD, DUPLICATE_ALERT_THRESHOLD],
  },
};

export interface CascadeSubject {
  /** Null before the issue exists (pre-create check). */
  id: string | null;
  parentId: string | null;
  text: IssueText;
}

export interface CascadeCandidate {
  id: string;
  identifier: string | null;
  status: string;
  parentId: string | null;
  createdAt: Date | null;
  text: IssueText;
  titleSimilarity: number;
  descriptionSimilarity: number;
}

export interface ScoredPair {
  candidate: CascadeCandidate;
  lexicalScore: number;
  sameOutcomeProbability: number | null;
  verdict: DuplicatePairVerdict;
  modelId: string | null;
  inputHash: string;
}

export interface CascadeResult {
  pairs: ScoredPair[];
  modelUsed: boolean;
  degradedReason: DuplicateDegradedReason | null;
}

function pairState(subject: CascadeSubject, candidate: CascadeCandidate): JudgeState {
  return {
    new_issue: { title: subject.text.title, description: subject.text.description },
    existing_issue: {
      title: candidate.text.title,
      description: candidate.text.description,
      status: candidate.status,
    },
  };
}

function rawLexicalScore(subject: CascadeSubject, candidate: CascadeCandidate): number {
  return lexicalScore({
    titleSimilarity: candidate.titleSimilarity,
    descriptionSimilarity: candidate.descriptionSimilarity,
    bothHaveDescriptions:
      normalizeIssueText(subject.text.description) !== "" && normalizeIssueText(candidate.text.description) !== "",
  });
}

/**
 * Orders candidates by lexical score with tree-relatives down-weighted, and keeps the top few.
 * Relatives stay eligible: a copied parent can be a real duplicate.
 */
export function rankCandidates(
  subject: CascadeSubject,
  candidates: readonly CascadeCandidate[],
  limit: number = DUPLICATE_CANDIDATE_LIMIT,
): CascadeCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      rank: rawLexicalScore(subject, candidate) * relationWeight(subject, candidate),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function verdictFromAnswer(answer: JudgeAnswer | undefined): {
  probability: number | null;
  verdict: DuplicatePairVerdict;
} {
  if (!answer || answer.type !== "predicate") return { probability: null, verdict: "uncertain" };
  if (answer.abstained || answer.probability === null) {
    return { probability: answer.probability, verdict: "uncertain" };
  }
  return {
    probability: answer.probability,
    verdict: answer.probability >= DUPLICATE_ALERT_THRESHOLD ? "likely_duplicate" : "distinct",
  };
}

/**
 * Tier 0 and tier 2 for each ranked candidate: an exact normalized-content match needs no model;
 * everything else asks `same_outcome` once per pair. Any model failure leaves that pair
 * `lexical_only` and is reported through `degradedReason`; nothing throws.
 */
export async function scoreCandidates(input: {
  mode: DuplicateDetectionMode;
  judge: JudgeClient;
  companyId: string;
  subject: CascadeSubject;
  candidates: readonly CascadeCandidate[];
}): Promise<CascadeResult> {
  const { mode, judge, companyId, subject } = input;
  const failures: JudgeFailureReason[] = [];
  let modelUsed = false;

  const pairs = await Promise.all(
    rankCandidates(subject, input.candidates).map(async (candidate): Promise<ScoredPair> => {
      const lexical = rawLexicalScore(subject, candidate);
      const state = pairState(subject, candidate);
      const inputHash = hashJudgeInput({
        rubricVersion: SAME_OUTCOME_RUBRIC_VERSION,
        state,
        questions: SAME_OUTCOME_QUESTIONS,
      });
      const tooShort = isTooShortForModel(subject.text, candidate.text);
      const lexicalOnly: ScoredPair = {
        candidate,
        lexicalScore: lexical,
        sameOutcomeProbability: null,
        verdict: "lexical_only",
        modelId: null,
        inputHash,
      };

      if (isExactDuplicate(subject.text, candidate.text)) {
        return { ...lexicalOnly, sameOutcomeProbability: 1, verdict: "exact" };
      }
      if (mode === "off" || tooShort) return lexicalOnly;

      const outcome = await judge.ask({
        companyId,
        rubricVersion: SAME_OUTCOME_RUBRIC_VERSION,
        state,
        questions: SAME_OUTCOME_QUESTIONS,
      });
      if (!outcome.ok) {
        failures.push(outcome.reason);
        return lexicalOnly;
      }
      modelUsed = true;
      const { probability, verdict } = verdictFromAnswer(outcome.answers.same_outcome);
      return {
        ...lexicalOnly,
        sameOutcomeProbability: probability,
        verdict,
        modelId: outcome.modelId,
      };
    }),
  );

  const degradedReason: DuplicateDegradedReason | null =
    mode === "off" ? "mode_off" : (failures[0] ?? null);
  return {
    pairs: pairs.sort((a, b) => (b.sameOutcomeProbability ?? b.lexicalScore) - (a.sameOutcomeProbability ?? a.lexicalScore)),
    modelUsed,
    degradedReason,
  };
}

/** Turns scored pairs into the advice an agent acts on before creating an issue. */
export function recommend(pairs: readonly ScoredPair[]): FindSimilarIssuesResult["recommendation"] {
  if (pairs.some((pair) => pair.verdict === "exact" || pair.verdict === "likely_duplicate")) {
    return "likely_duplicate";
  }
  const worthALook = pairs.some(
    (pair) =>
      (pair.verdict === "uncertain" &&
        (pair.sameOutcomeProbability === null || pair.sameOutcomeProbability >= DUPLICATE_REVIEW_THRESHOLD)) ||
      (pair.verdict === "lexical_only" && pair.lexicalScore >= DUPLICATE_LEXICAL_REVIEW_THRESHOLD),
  );
  return worthALook ? "review_candidates" : "create";
}
