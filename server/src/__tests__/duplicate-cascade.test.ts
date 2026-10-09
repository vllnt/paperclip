import { describe, expect, it, vi } from "vitest";
import {
  DUPLICATE_ALERT_THRESHOLD,
  DUPLICATE_CANDIDATE_LIMIT,
  recommend,
  scoreCandidates,
  type CascadeCandidate,
  type CascadeSubject,
} from "../services/duplicate-cascade.js";
import {
  DUPLICATE_TITLE_MAX_CHARS,
  RELATED_ISSUE_WEIGHT,
  exactContentHash,
  isExactDuplicate,
  isTooShortForModel,
  lexicalScore,
  normalizeIssueText,
  prepareIssueText,
  relationWeight,
  trigramSimilarity,
} from "../services/duplicate-lexical.js";
import { createBoundedRunner } from "../services/duplicate-detection.js";
import type { JudgeClient, JudgeOutcome } from "../services/judge-client.js";

const COMPANY = "00000000-0000-0000-0000-00000000000a";

function subject(overrides: Partial<CascadeSubject> = {}): CascadeSubject {
  return {
    id: null,
    parentId: null,
    text: { title: "Remove @songtrivia/client compatibility barrels", description: "" },
    ...overrides,
  };
}

let nextId = 0;
function candidate(overrides: Partial<CascadeCandidate> & { title?: string; description?: string } = {}): CascadeCandidate {
  nextId += 1;
  const { title, description, ...rest } = overrides;
  return {
    id: `candidate-${nextId}`,
    identifier: `ANT-${nextId}`,
    status: "todo",
    parentId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    text: { title: title ?? "Remove @songtrivia/client compatibility barrels", description: description ?? "" },
    titleSimilarity: 0.8,
    descriptionSimilarity: 0,
    ...rest,
  };
}

function judgeAnswering(probability: number | null, abstained = false): JudgeClient & { ask: ReturnType<typeof vi.fn> } {
  const outcome: JudgeOutcome = {
    ok: true,
    answers: { same_outcome: { type: "predicate", probability, abstained } },
    modelId: "typesafe-ai/jev-1.2",
    inputHash: "hash",
    cached: false,
  };
  return { isConfigured: () => true, ask: vi.fn(async () => outcome) };
}

function judgeFailing(reason: "no_key" | "cap_exceeded" | "timeout" | "error"): JudgeClient & { ask: ReturnType<typeof vi.fn> } {
  return { isConfigured: () => false, ask: vi.fn(async () => ({ ok: false as const, reason, inputHash: "hash" })) };
}

describe("lexical helpers", () => {
  it("normalizes case, punctuation and spacing", () => {
    expect(normalizeIssueText("  [Chore]  Remove   @songtrivia/client! ")).toBe("chore remove songtrivia client");
    expect(exactContentHash({ title: "Fix  Login", description: "A" })).toBe(
      exactContentHash({ title: "fix login", description: "a" }),
    );
    expect(exactContentHash({ title: "Fix login", description: "A." })).not.toBe(
      exactContentHash({ title: "Fix login", description: "A" }),
    );
    expect(exactContentHash({ title: "Fix login", description: "" })).not.toBe(
      exactContentHash({ title: "Fix logout", description: "" }),
    );
  });

  it("matches the documented pg_trgm similarity values", () => {
    expect(trigramSimilarity("word", "two words")).toBeCloseTo(0.363636, 5);
    expect(trigramSimilarity("same", "same")).toBe(1);
    expect(trigramSimilarity("", "anything")).toBe(0);
  });

  it("ignores a missing description instead of dragging the score down", () => {
    expect(lexicalScore({ titleSimilarity: 0.9, descriptionSimilarity: 0, bothHaveDescriptions: false })).toBe(0.9);
    expect(lexicalScore({ titleSimilarity: 0.9, descriptionSimilarity: 0.5, bothHaveDescriptions: true })).toBeCloseTo(0.74);
  });

  it("down-weights ancestors, descendants and siblings but not strangers", () => {
    const parent = { id: "p", parentId: null };
    expect(relationWeight({ id: null, parentId: "p" }, parent)).toBe(RELATED_ISSUE_WEIGHT);
    expect(relationWeight({ id: null, parentId: "p" }, { id: "s", parentId: "p" })).toBe(RELATED_ISSUE_WEIGHT);
    expect(relationWeight({ id: "n", parentId: null }, { id: "c", parentId: "n" })).toBe(RELATED_ISSUE_WEIGHT);
    expect(relationWeight({ id: "n", parentId: "p" }, { id: "x", parentId: "q" })).toBe(1);
    expect(relationWeight({ id: null, parentId: null }, { id: "x", parentId: null })).toBe(1);
  });

  it("truncates descriptions, redacts secrets, and flags thin pairs", () => {
    const prepared = prepareIssueText({
      title: "Deploy fix",
      description: `${"x".repeat(2_000)}`,
    });
    expect(prepared.description).toHaveLength(1_500);
    const secret = prepareIssueText({ title: "Rotate", description: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(secret.description).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(isTooShortForModel({ title: "Fix bug", description: "" }, { title: "Fix the login bug", description: "" })).toBe(true);
    expect(isTooShortForModel({ title: "Fix the login bug", description: "" }, { title: "Fix the logout bug", description: "" })).toBe(false);
  });
});

describe("exact duplicates", () => {
  it("does not treat symbol-only differences as identical", () => {
    expect(
      isExactDuplicate({ title: "Migrate C++ build pipeline today", description: "" }, { title: "Migrate C# build pipeline today", description: "" }),
    ).toBe(false);
  });

  it("never counts truncated descriptions or short generic titles", () => {
    const long = "x".repeat(1_500);
    expect(isExactDuplicate({ title: "Rotate the staging database credentials", description: long }, { title: "Rotate the staging database credentials", description: long })).toBe(false);
    expect(isExactDuplicate({ title: "Review pull request", description: "" }, { title: "Review pull request", description: "" })).toBe(false);
    expect(isExactDuplicate({ title: "Rotate the staging database credentials", description: "" }, { title: "rotate the staging  database credentials", description: "" })).toBe(true);
  });

  it("bounds oversized titles and redacts before sending", () => {
    const prepared = prepareIssueText({ title: "t".repeat(100_000), description: "d".repeat(1_000_000) });
    expect(prepared.title).toHaveLength(DUPLICATE_TITLE_MAX_CHARS);
    expect(prepared.description).toHaveLength(1_500);
  });
});

describe("bounded runner", () => {
  it("limits concurrency, drops work past the wait list, and never throws", async () => {
    const run = createBoundedRunner(2, 1);
    let active = 0;
    let peak = 0;
    let completed = 0;
    const release: Array<() => void> = [];
    const job = () =>
      new Promise<void>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        release.push(() => {
          active -= 1;
          completed += 1;
          resolve();
        });
      });
    const first = run(job);
    const second = run(job);
    const third = run(job);
    const dropped = run(job);
    await dropped;
    expect(release).toHaveLength(2);
    release[0]?.();
    await first;
    expect(release).toHaveLength(3);
    release[1]?.();
    release[2]?.();
    await Promise.all([second, third]);
    expect(peak).toBe(2);
    expect(completed).toBe(3);
    await expect(createBoundedRunner(1, 1)(async () => { throw new Error("boom"); })).resolves.toBeUndefined();
  });
});

describe("scoreCandidates", () => {
  it("resolves exact content matches without a model call", async () => {
    const judge = judgeAnswering(0.1);
    const result = await scoreCandidates({
      mode: "suggest",
      judge,
      companyId: COMPANY,
      subject: subject(),
      candidates: [candidate({ title: "remove  @songtrivia/client compatibility   barrels" })],
    });
    expect(judge.ask).not.toHaveBeenCalled();
    expect(result.pairs[0]).toMatchObject({ verdict: "exact", sameOutcomeProbability: 1, modelId: null });
    expect(recommend(result.pairs)).toBe("likely_duplicate");
  });

  it("stays lexical-only and sends nothing when the company mode is off", async () => {
    const judge = judgeAnswering(0.99);
    const result = await scoreCandidates({
      mode: "off",
      judge,
      companyId: COMPANY,
      subject: subject(),
      candidates: [candidate({ title: "Remove client barrels from songtrivia" })],
    });
    expect(judge.ask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ modelUsed: false, degradedReason: "mode_off" });
    expect(result.pairs[0]).toMatchObject({ verdict: "lexical_only", sameOutcomeProbability: null });
  });

  it("maps probabilities to verdicts around the alert and distinct thresholds", async () => {
    const run = async (probability: number, abstained: boolean) =>
      (
        await scoreCandidates({
          mode: "comment",
          judge: judgeAnswering(probability, abstained),
          companyId: COMPANY,
          subject: subject(),
          candidates: [candidate({ title: "Remove client barrels from songtrivia" })],
        })
      ).pairs[0];

    expect(await run(0.95, false)).toMatchObject({ verdict: "likely_duplicate", sameOutcomeProbability: 0.95 });
    expect(await run(DUPLICATE_ALERT_THRESHOLD, false)).toMatchObject({ verdict: "likely_duplicate" });
    expect(await run(0.05, false)).toMatchObject({ verdict: "distinct" });
    expect(await run(0.6, true)).toMatchObject({ verdict: "uncertain", sameOutcomeProbability: 0.6 });
  });

  it("treats a model refusal as uncertain and records no probability", async () => {
    const result = await scoreCandidates({
      mode: "suggest",
      judge: judgeAnswering(null, true),
      companyId: COMPANY,
      subject: subject(),
      candidates: [candidate({ title: "Remove client barrels from songtrivia" })],
    });
    expect(result.pairs[0]).toMatchObject({ verdict: "uncertain", sameOutcomeProbability: null });
    expect(recommend(result.pairs)).toBe("review_candidates");
  });

  it.each(["no_key", "cap_exceeded", "timeout", "error"] as const)(
    "falls back to the lexical tier when the model fails with %s",
    async (reason) => {
      const result = await scoreCandidates({
        mode: "suggest",
        judge: judgeFailing(reason),
        companyId: COMPANY,
        subject: subject(),
        candidates: [candidate({ title: "Remove client barrels from songtrivia", titleSimilarity: 0.9 })],
      });
      expect(result).toMatchObject({ modelUsed: false, degradedReason: reason });
      expect(result.pairs[0]).toMatchObject({ verdict: "lexical_only", sameOutcomeProbability: null, modelId: null });
      expect(recommend(result.pairs)).toBe("review_candidates");
    },
  );

  it("never asks the model about pairs too short to judge", async () => {
    const judge = judgeAnswering(0.99);
    const result = await scoreCandidates({
      mode: "suggest",
      judge,
      companyId: COMPANY,
      subject: subject({ text: { title: "Fix bug", description: "" } }),
      candidates: [candidate({ title: "Fix bug" })],
    });
    expect(judge.ask).not.toHaveBeenCalled();
    expect(result.pairs[0]?.verdict).toBe("lexical_only");
    expect(result.degradedReason).toBeNull();
  });

  it("scores only the top candidates, ranking tree relatives lower", async () => {
    const judge = judgeAnswering(0.1);
    const parent = candidate({ id: "parent", titleSimilarity: 0.95 });
    const strangers = Array.from({ length: DUPLICATE_CANDIDATE_LIMIT }, (_, index) =>
      candidate({ title: `Remove client barrels ${index}`, titleSimilarity: 0.9 - index * 0.01 }),
    );
    const result = await scoreCandidates({
      mode: "suggest",
      judge,
      companyId: COMPANY,
      subject: subject({ parentId: "parent" }),
      candidates: [parent, ...strangers],
    });
    expect(judge.ask).toHaveBeenCalledTimes(DUPLICATE_CANDIDATE_LIMIT);
    expect(result.pairs.map((pair) => pair.candidate.id)).not.toContain("parent");
  });

  it("sends the model only the truncated, minimal fields and the company id", async () => {
    const judge = judgeAnswering(0.1);
    await scoreCandidates({
      mode: "suggest",
      judge,
      companyId: COMPANY,
      subject: subject({ text: { title: "Remove client barrels", description: "details" } }),
      candidates: [candidate({ title: "Remove client barrels now", description: "more details" })],
    });
    const request = judge.ask.mock.calls[0]?.[0];
    expect(request.companyId).toBe(COMPANY);
    expect(request.state).toEqual({
      new_issue: { title: "Remove client barrels", description: "details" },
      existing_issue: { title: "Remove client barrels now", description: "more details", status: "todo" },
    });
  });
});

describe("recommend", () => {
  it("only recommends creating when nothing is similar enough", async () => {
    const result = await scoreCandidates({
      mode: "suggest",
      judge: judgeAnswering(0.02),
      companyId: COMPANY,
      subject: subject(),
      candidates: [candidate({ title: "Add dark mode to billing settings", titleSimilarity: 0.31 })],
    });
    expect(recommend(result.pairs)).toBe("create");
    expect(recommend([])).toBe("create");
  });
});
