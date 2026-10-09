import { z } from "zod";
import type { DuplicatePairVerdict } from "@paperclipai/shared";
import type { CascadeCandidate, CascadeSubject } from "./duplicate-cascade.js";
import {
  DUPLICATE_ALERT_THRESHOLD,
  DUPLICATE_DISTINCT_THRESHOLD,
} from "./duplicate-cascade.js";
import {
  DUPLICATE_DESCRIPTION_MAX_CHARS,
  exactContentHash,
  lexicalScore,
  normalizeIssueText,
  prepareIssueText,
  trigramSimilarity,
  type IssueText,
} from "./duplicate-lexical.js";

/** Target precision at the comment threshold before comments may be enabled for a company. */
export const COMMENT_PRECISION_TARGET = 0.9;
/** Minimum title/description similarity for pg_trgm `%` to return a candidate at all. */
export const TRIGRAM_RETRIEVAL_FLOOR = 0.3;

const issueTextSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
});

const labelSchema = z.union([
  z.boolean(),
  z.enum(["duplicate", "distinct", "keep_both"]).transform((label) => label === "duplicate"),
]);

const labelledPairSchema = z.object({
  id: z.string().optional(),
  a: issueTextSchema,
  b: issueTextSchema,
  label: labelSchema,
});

export interface LabelledPair {
  id: string;
  a: IssueText;
  b: IssueText;
  duplicate: boolean;
}

/**
 * Validates a JSON export of labelled pairs: `[{ id?, a: {title, description?}, b: {...}, label }]`
 * where `label` is `true`/`false` or "duplicate" / "distinct" / "keep_both".
 * @throws ZodError with the path of the first bad entry.
 */
export function parseLabelledPairs(json: unknown): LabelledPair[] {
  return z
    .array(labelledPairSchema)
    .min(1)
    .parse(json)
    .map((entry, index) => ({
      id: entry.id ?? `pair-${index + 1}`,
      a: prepareIssueText(entry.a),
      b: prepareIssueText(entry.b),
      duplicate: entry.label,
    }));
}

export interface LexicalFeatures {
  titleSimilarity: number;
  descriptionSimilarity: number;
  lexical: number;
  exact: boolean;
  retrievable: boolean;
}

/** Tier-1 numbers for a pair, computed offline exactly as production computes them. */
export function lexicalFeatures(pair: Pick<LabelledPair, "a" | "b">): LexicalFeatures {
  const titleSimilarity = trigramSimilarity(pair.a.title, pair.b.title);
  const descriptionSimilarity = trigramSimilarity(
    pair.a.description.slice(0, DUPLICATE_DESCRIPTION_MAX_CHARS),
    pair.b.description.slice(0, DUPLICATE_DESCRIPTION_MAX_CHARS),
  );
  const bothHaveDescriptions =
    normalizeIssueText(pair.a.description) !== "" && normalizeIssueText(pair.b.description) !== "";
  return {
    titleSimilarity,
    descriptionSimilarity,
    lexical: lexicalScore({ titleSimilarity, descriptionSimilarity, bothHaveDescriptions }),
    exact: exactContentHash(pair.a) === exactContentHash(pair.b),
    retrievable:
      titleSimilarity >= TRIGRAM_RETRIEVAL_FLOOR ||
      (bothHaveDescriptions && descriptionSimilarity >= TRIGRAM_RETRIEVAL_FLOOR),
  };
}

/** Adapts a labelled pair to the cascade's input so the harness exercises the production code path. */
export function toCascadeInput(pair: LabelledPair): { subject: CascadeSubject; candidate: CascadeCandidate } {
  const features = lexicalFeatures(pair);
  return {
    subject: { id: null, parentId: null, text: pair.a },
    candidate: {
      id: pair.id,
      identifier: pair.id,
      status: "todo",
      parentId: null,
      createdAt: null,
      text: pair.b,
      titleSimilarity: features.titleSimilarity,
      descriptionSimilarity: features.descriptionSimilarity,
    },
  };
}

export interface ScoredLabelledPair {
  pair: LabelledPair;
  features: LexicalFeatures;
  probability: number | null;
  verdict: DuplicatePairVerdict;
  modelFailed: boolean;
}

export interface ThresholdRow {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
}

function row(threshold: number, predictions: ReadonlyArray<{ predicted: boolean; actual: boolean }>): ThresholdRow {
  const count = (predicted: boolean, actual: boolean) =>
    predictions.filter((entry) => entry.predicted === predicted && entry.actual === actual).length;
  const tp = count(true, true);
  const fp = count(true, false);
  const fn = count(false, true);
  return {
    threshold,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: count(false, false),
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

export const DEFAULT_THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.97] as const;

export interface CalibrationReport {
  pairs: number;
  positives: number;
  negatives: number;
  retrievablePositives: number;
  modelCalls: number;
  modelFailures: number;
  abstained: number;
  tier1: ThresholdRow[];
  tier1PlusJev: ThresholdRow[] | null;
  commentThreshold: number;
  commentPrecision: number | null;
  commentsAllowed: boolean;
}

/**
 * Precision and recall by threshold for tier 1 alone and for tier 1 plus Jev.
 *
 * - Tier 1 predicts "duplicate" when the pair is an exact match or its lexical score reaches the threshold.
 * - Tier 1 + Jev predicts "duplicate" when the pair is an exact match, or retrievable by trigram and
 *   Jev's same-outcome probability reaches the threshold. Pairs the model abstained on or could not
 *   score count as "not duplicate" (the production path would not comment on them).
 *
 * Pass `withModel: false` for a tier-1-only report.
 */
export function buildCalibrationReport(
  scored: readonly ScoredLabelledPair[],
  options: { withModel: boolean; thresholds?: readonly number[]; commentThreshold?: number } = { withModel: true },
): CalibrationReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const commentThreshold = options.commentThreshold ?? DUPLICATE_ALERT_THRESHOLD;
  const tier1 = thresholds.map((threshold) =>
    row(
      threshold,
      scored.map(({ pair, features }) => ({
        predicted: features.exact || features.lexical >= threshold,
        actual: pair.duplicate,
      })),
    ),
  );
  const jevRows = options.withModel
    ? [...new Set([...thresholds, commentThreshold])]
        .sort((a, b) => a - b)
        .map((threshold) =>
          row(
            threshold,
            scored.map(({ pair, features, probability, verdict }) => ({
              predicted:
                verdict === "exact" ||
                (features.retrievable && probability !== null && verdict !== "uncertain" && probability >= threshold),
              actual: pair.duplicate,
            })),
          ),
        )
    : null;
  const atComment = jevRows?.find((entry) => entry.threshold === commentThreshold) ?? null;
  const commentPrecision = atComment?.precision ?? null;
  return {
    pairs: scored.length,
    positives: scored.filter(({ pair }) => pair.duplicate).length,
    negatives: scored.filter(({ pair }) => !pair.duplicate).length,
    retrievablePositives: scored.filter(({ pair, features }) => pair.duplicate && (features.retrievable || features.exact)).length,
    modelCalls: scored.filter(({ probability, verdict }) => probability !== null && verdict !== "exact").length,
    modelFailures: scored.filter(({ modelFailed }) => modelFailed).length,
    abstained: scored.filter(({ verdict }) => verdict === "uncertain").length,
    tier1,
    tier1PlusJev: jevRows,
    commentThreshold,
    commentPrecision,
    commentsAllowed: commentPrecision !== null && commentPrecision >= COMMENT_PRECISION_TARGET,
  };
}

function percent(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function table(title: string, rows: readonly ThresholdRow[]): string[] {
  return [
    title,
    "  threshold  precision  recall   TP   FP   FN   TN",
    ...rows.map(
      (entry) =>
        `  ${entry.threshold.toFixed(2).padStart(9)}  ${percent(entry.precision)}   ${percent(entry.recall)}  ` +
        `${String(entry.truePositives).padStart(3)}  ${String(entry.falsePositives).padStart(3)}  ` +
        `${String(entry.falseNegatives).padStart(3)}  ${String(entry.trueNegatives).padStart(3)}`,
    ),
  ];
}

/** Plain-text report for the terminal. */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines = [
    `Pairs: ${report.pairs} (${report.positives} duplicate, ${report.negatives} not)`,
    `Duplicates reachable by tier 1 (exact or trigram >= ${TRIGRAM_RETRIEVAL_FLOOR}): ${report.retrievablePositives}/${report.positives}`,
    `Distinct/abstain band: model abstains between ${DUPLICATE_DISTINCT_THRESHOLD} and ${DUPLICATE_ALERT_THRESHOLD}`,
    "",
    ...table("Tier 1 alone (trigram lexical score)", report.tier1),
  ];
  if (report.tier1PlusJev) {
    lines.push(
      "",
      ...table("Tier 1 + Jev (same_outcome probability)", report.tier1PlusJev),
      "",
      `Model calls: ${report.modelCalls}, failures: ${report.modelFailures}, abstained: ${report.abstained}`,
      `Precision at comment threshold ${report.commentThreshold}: ${percent(report.commentPrecision).trim()} ` +
        `(target ${(COMMENT_PRECISION_TARGET * 100).toFixed(0)}%)`,
      report.commentsAllowed
        ? "Verdict: precision target met. Comment mode may be enabled."
        : "Verdict: precision target NOT met (or no data). Keep the company on `suggest`; the similar API stays on, no comments.",
    );
  }
  return lines.join("\n");
}
