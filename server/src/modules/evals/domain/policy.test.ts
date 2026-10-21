import { describe, expect, it } from "vitest";
import {
  anyAnswerAbstained,
  feedbackAuthorKey,
  inputExpiry,
  isVisibleToAgents,
  resolveRunMode,
  toRunAnswers,
} from "./policy.js";

describe("isVisibleToAgents", () => {
  it("is true only for a published eval with a published version", () => {
    expect(isVisibleToAgents({ status: "published", publishedVersionId: "v1" })).toBe(true);
    expect(isVisibleToAgents({ status: "published", publishedVersionId: null })).toBe(false);
    expect(isVisibleToAgents({ status: "draft", publishedVersionId: null })).toBe(false);
    expect(isVisibleToAgents({ status: "draft", publishedVersionId: "v1" })).toBe(false);
    expect(isVisibleToAgents({ status: "archived", publishedVersionId: "v1" })).toBe(false);
    expect(isVisibleToAgents({ status: "archived", publishedVersionId: null })).toBe(false);
  });
});

describe("resolveRunMode", () => {
  it("is live for the published version of a published eval", () => {
    expect(
      resolveRunMode({ evalStatus: "published", publishedVersionId: "v2", runVersionId: "v2", requestedMode: undefined }),
    ).toBe("live");
  });

  it("is try_it when the caller asks for it", () => {
    expect(
      resolveRunMode({ evalStatus: "published", publishedVersionId: "v2", runVersionId: "v2", requestedMode: "try_it" }),
    ).toBe("try_it");
  });

  it("is try_it for a version that is not the published one", () => {
    expect(
      resolveRunMode({ evalStatus: "published", publishedVersionId: "v2", runVersionId: "v3", requestedMode: undefined }),
    ).toBe("try_it");
    expect(
      resolveRunMode({ evalStatus: "published", publishedVersionId: "v2", runVersionId: "v1", requestedMode: undefined }),
    ).toBe("try_it");
  });

  it("is try_it for a draft eval, with or without a published version id", () => {
    expect(
      resolveRunMode({ evalStatus: "draft", publishedVersionId: null, runVersionId: "v1", requestedMode: undefined }),
    ).toBe("try_it");
    expect(
      resolveRunMode({ evalStatus: "draft", publishedVersionId: "v1", runVersionId: "v1", requestedMode: undefined }),
    ).toBe("try_it");
  });

  it("is try_it for an archived eval, even at the version it had published", () => {
    expect(
      resolveRunMode({ evalStatus: "archived", publishedVersionId: "v1", runVersionId: "v1", requestedMode: undefined }),
    ).toBe("try_it");
  });
});

describe("inputExpiry", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("adds the retention days to now", () => {
    expect(inputExpiry(now, 30)?.toISOString()).toBe("2026-11-08T12:00:00.000Z");
    expect(inputExpiry(now, 1)?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });

  it("is null when the retention is 0, so no input is stored", () => {
    expect(inputExpiry(now, 0)).toBeNull();
  });

  it("is null for a negative or non-finite retention", () => {
    expect(inputExpiry(now, -1)).toBeNull();
    expect(inputExpiry(now, Number.NaN)).toBeNull();
    expect(inputExpiry(now, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("does not change the date it is given", () => {
    inputExpiry(now, 30);
    expect(now.toISOString()).toBe("2026-10-09T12:00:00.000Z");
  });
});

describe("feedbackAuthorKey", () => {
  it("prefixes the author kind", () => {
    expect(feedbackAuthorKey({ type: "agent", agentId: "a-1" })).toBe("agent:a-1");
    expect(feedbackAuthorKey({ type: "user", userId: "u-1" })).toBe("user:u-1");
  });

  it("keeps an agent and a user with the same id apart", () => {
    expect(feedbackAuthorKey({ type: "agent", agentId: "same" })).not.toBe(feedbackAuthorKey({ type: "user", userId: "same" }));
  });
});

describe("toRunAnswers", () => {
  it("adds value true at a probability of 0.5 or more", () => {
    const answers = toRunAnswers({
      at_half: { type: "predicate", probability: 0.5, abstained: false },
      high: { type: "predicate", probability: 0.91, abstained: false },
      one: { type: "predicate", probability: 1, abstained: false },
    });
    expect(answers.at_half).toEqual({ type: "predicate", probability: 0.5, value: true, abstained: false });
    expect(answers.high).toMatchObject({ value: true });
    expect(answers.one).toMatchObject({ value: true });
  });

  it("adds value false below 0.5", () => {
    const answers = toRunAnswers({
      just_below: { type: "predicate", probability: 0.4999, abstained: false },
      zero: { type: "predicate", probability: 0, abstained: false },
    });
    expect(answers.just_below).toEqual({ type: "predicate", probability: 0.4999, value: false, abstained: false });
    expect(answers.zero).toMatchObject({ value: false });
  });

  it("adds value null when the answer abstained, and keeps the probability", () => {
    const answers = toRunAnswers({
      band: { type: "predicate", probability: 0.6, abstained: true },
      refused: { type: "predicate", probability: null, abstained: true },
    });
    expect(answers.band).toEqual({ type: "predicate", probability: 0.6, value: null, abstained: true });
    expect(answers.refused).toEqual({ type: "predicate", probability: null, value: null, abstained: true });
  });

  it("passes choice and score answers through unchanged and adds no value", () => {
    const probabilities = { none: 0.05, smoke: 0.71 };
    const answers = toRunAnswers({
      depth: { type: "choice", choice: "smoke", probabilities, confidence: 0.71, abstained: false },
      risk: { type: "score", score: 3, confidence: 0.4, abstained: true },
    });
    expect(answers.depth).toEqual({ type: "choice", choice: "smoke", probabilities, confidence: 0.71, abstained: false });
    expect(answers.risk).toEqual({ type: "score", score: 3, confidence: 0.4, abstained: true });
    expect(Object.hasOwn(answers.depth ?? {}, "value")).toBe(false);
    expect(Object.hasOwn(answers.risk ?? {}, "value")).toBe(false);
  });

  it("copies the probabilities of a choice and keeps a null one", () => {
    const probabilities = { a: 0.5, b: 0.5 };
    const answers = toRunAnswers({
      copy: { type: "choice", choice: "a", probabilities, confidence: 0.5, abstained: false },
      none: { type: "choice", choice: null, probabilities: null, confidence: null, abstained: true },
    });
    const copied = answers.copy;
    expect(copied?.type === "choice" ? copied.probabilities : undefined).toEqual(probabilities);
    expect(copied?.type === "choice" ? copied.probabilities : undefined).not.toBe(probabilities);
    expect(answers.none).toEqual({ type: "choice", choice: null, probabilities: null, confidence: null, abstained: true });
  });

  it("keeps every question id", () => {
    const answers = toRunAnswers({
      a: { type: "predicate", probability: 0.9, abstained: false },
      b: { type: "score", score: 1, confidence: 0.9, abstained: false },
    });
    expect(Object.keys(answers).sort()).toEqual(["a", "b"]);
  });
});

describe("anyAnswerAbstained", () => {
  it("is true when at least one answer abstained", () => {
    expect(anyAnswerAbstained({ a: { abstained: false }, b: { abstained: true } })).toBe(true);
  });

  it("is false when none abstained or there are no answers", () => {
    expect(anyAnswerAbstained({ a: { abstained: false } })).toBe(false);
    expect(anyAnswerAbstained({})).toBe(false);
  });
});
