import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  formatCalibrationReport,
  lexicalFeatures,
  parseLabelledPairs,
  type ScoredLabelledPair,
} from "../services/duplicate-calibration.js";

const SAMPLE = fileURLToPath(new URL("../../scripts/fixtures/duplicate-pairs.sample.json", import.meta.url));

function scored(
  overrides: Partial<ScoredLabelledPair> & { duplicate: boolean; lexical: number; retrievable?: boolean; exact?: boolean },
): ScoredLabelledPair {
  const { duplicate, lexical, retrievable = true, exact = false, ...rest } = overrides;
  return {
    pair: { id: "p", a: { title: "a", description: "" }, b: { title: "b", description: "" }, duplicate },
    features: { titleSimilarity: lexical, descriptionSimilarity: 0, lexical, exact, retrievable },
    probability: null,
    verdict: "lexical_only",
    modelFailed: false,
    ...rest,
  };
}

describe("parseLabelledPairs", () => {
  it("accepts boolean and named labels and numbers unnamed pairs", () => {
    const pairs = parseLabelledPairs([
      { a: { title: "One" }, b: { title: "Two" }, label: true },
      { id: "x", a: { title: "One", description: "d" }, b: { title: "Two" }, label: "keep_both" },
      { a: { title: "One" }, b: { title: "Two" }, label: "duplicate" },
    ]);
    expect(pairs.map((pair) => [pair.id, pair.duplicate])).toEqual([
      ["pair-1", true],
      ["x", false],
      ["pair-3", true],
    ]);
  });

  it("rejects empty exports and unknown labels", () => {
    expect(() => parseLabelledPairs([])).toThrow();
    expect(() => parseLabelledPairs([{ a: { title: "x" }, b: { title: "y" }, label: "maybe" }])).toThrow();
  });

  it("loads the shipped sample export", () => {
    const pairs = parseLabelledPairs(JSON.parse(readFileSync(SAMPLE, "utf8")));
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    expect(pairs.some((pair) => pair.duplicate)).toBe(true);
    expect(pairs.some((pair) => !pair.duplicate)).toBe(true);
  });
});

describe("lexicalFeatures", () => {
  it("flags identical text as exact and unrelated text as not retrievable", () => {
    const same = { a: { title: "Remove client barrels from songtrivia", description: "" }, b: { title: "remove  CLIENT barrels from songtrivia", description: "" } };
    expect(lexicalFeatures(same)).toMatchObject({ exact: true, retrievable: true, lexical: 1 });
    const unrelated = { a: { title: "Remove client barrels", description: "" }, b: { title: "Dark mode billing page", description: "" } };
    expect(lexicalFeatures(unrelated)).toMatchObject({ exact: false, retrievable: false });
  });
});

describe("buildCalibrationReport", () => {
  const pairs: ScoredLabelledPair[] = [
    scored({ duplicate: true, lexical: 0.95 }),
    scored({ duplicate: true, lexical: 0.7 }),
    scored({ duplicate: false, lexical: 0.8 }),
    scored({ duplicate: false, lexical: 0.2, retrievable: false }),
  ];

  it("computes tier-1 precision and recall per threshold", () => {
    const report = buildCalibrationReport(pairs, { withModel: false, thresholds: [0.5, 0.75, 0.9] });
    expect(report.tier1PlusJev).toBeNull();
    expect(report.tier1.map((entry) => [entry.threshold, entry.truePositives, entry.falsePositives, entry.falseNegatives])).toEqual([
      [0.5, 2, 1, 0],
      [0.75, 1, 1, 1],
      [0.9, 1, 0, 1],
    ]);
    expect(report.tier1[0]).toMatchObject({ precision: 2 / 3, recall: 1 });
    expect(report.tier1[2]).toMatchObject({ precision: 1, recall: 0.5 });
    expect(report).toMatchObject({ pairs: 4, positives: 2, negatives: 2, commentsAllowed: false });
  });

  it("reports null precision when nothing is predicted instead of dividing by zero", () => {
    const report = buildCalibrationReport([scored({ duplicate: true, lexical: 0.1 })], { withModel: false, thresholds: [0.9] });
    expect(report.tier1[0]).toMatchObject({ precision: null, recall: 0 });
  });

  it("gates comments on precision at the comment threshold, ignoring abstains and failures", () => {
    const withModel = [
      scored({ duplicate: true, lexical: 0.8, probability: 0.97, verdict: "likely_duplicate" }),
      scored({ duplicate: true, lexical: 0.8, probability: 0.93, verdict: "likely_duplicate" }),
      scored({ duplicate: false, lexical: 0.8, probability: 0.55, verdict: "uncertain" }),
      scored({ duplicate: false, lexical: 0.9, probability: 0.1, verdict: "distinct" }),
      scored({ duplicate: true, lexical: 0.9, retrievable: true, probability: null, modelFailed: true }),
    ];
    const report = buildCalibrationReport(withModel, { withModel: true });
    expect(report.commentPrecision).toBe(1);
    expect(report.commentsAllowed).toBe(true);
    expect(report).toMatchObject({ modelCalls: 4, modelFailures: 1, abstained: 1 });

    const noisy = [...withModel, scored({ duplicate: false, lexical: 0.8, probability: 0.96, verdict: "likely_duplicate" })];
    const noisyReport = buildCalibrationReport(noisy, { withModel: true });
    expect(noisyReport.commentPrecision).toBeCloseTo(2 / 3, 5);
    expect(noisyReport.commentsAllowed).toBe(false);
  });

  it("counts exact matches as duplicates without a model score, and unretrievable pairs as missed", () => {
    const report = buildCalibrationReport(
      [
        scored({ duplicate: true, lexical: 1, exact: true, verdict: "exact", probability: 1 }),
        scored({ duplicate: true, lexical: 0.1, retrievable: false, probability: 0.99, verdict: "likely_duplicate" }),
      ],
      { withModel: true },
    );
    const atComment = report.tier1PlusJev?.find((entry) => entry.threshold === 0.9);
    expect(atComment).toMatchObject({ truePositives: 1, falseNegatives: 1 });
    expect(report.retrievablePositives).toBe(1);
  });

  it("prints a readable verdict", () => {
    const text = formatCalibrationReport(
      buildCalibrationReport([scored({ duplicate: true, lexical: 0.9, probability: 0.95, verdict: "likely_duplicate" })], { withModel: true }),
    );
    expect(text).toContain("Tier 1 alone");
    expect(text).toContain("Tier 1 + Jev");
    expect(text).toContain("precision target met");
  });
});
