import { describe, expect, it } from "vitest";
import type { JudgeClient, JudgeOutcome, JudgeRequest } from "../../../services/judge-client.js";
import { createJudgeTriageModel } from "./judge.js";

const request = {
  companyId: "company-1",
  rubricVersion: "v1",
  state: { issue: { title: "A title with words", description: "" } },
  questions: { category: { type: "choice" as const, instructions: "Pick", options: { bug: "A bug", other: "Other" } } },
};

function judgeReturning(outcome: JudgeOutcome, seen: JudgeRequest[] = []): JudgeClient {
  return {
    isAvailable: async () => true,
    ask: async (asked) => {
      seen.push(asked);
      return outcome;
    },
  };
}

describe("createJudgeTriageModel", () => {
  it("passes the request to the judge client and reads choice answers", async () => {
    const seen: JudgeRequest[] = [];
    const model = createJudgeTriageModel(
      judgeReturning(
        {
          ok: true,
          modelId: "typesafe-ai/jev",
          inputHash: "h",
          cached: true,
          answers: { category: { type: "choice", choice: "bug", probabilities: { bug: 0.9, other: 0.1 }, confidence: 0.9, abstained: false } },
        },
        seen,
      ),
    );
    const outcome = await model.ask(request);
    expect(seen[0]).toMatchObject({ companyId: "company-1", rubricVersion: "v1" });
    expect(outcome).toEqual({
      ok: true,
      modelId: "typesafe-ai/jev",
      inputHash: "h",
      cached: true,
      answers: { category: { choice: "bug", probabilities: { bug: 0.9, other: 0.1 }, abstained: false } },
    });
  });

  it("passes failures through", async () => {
    const model = createJudgeTriageModel(judgeReturning({ ok: false, reason: "cap_exceeded", inputHash: "h" }));
    expect(await model.ask(request)).toEqual({ ok: false, reason: "cap_exceeded", inputHash: "h" });
  });

  it("treats a non-choice answer as an error", async () => {
    const model = createJudgeTriageModel(
      judgeReturning({
        ok: true,
        modelId: "m",
        inputHash: "h",
        cached: false,
        answers: { category: { type: "predicate", probability: 0.5, abstained: false } },
      }),
    );
    expect(await model.ask(request)).toEqual({ ok: false, reason: "error", inputHash: "h" });
  });

  it("reports availability from the judge client", async () => {
    expect(await createJudgeTriageModel(judgeReturning({ ok: false, reason: "no_key", inputHash: "h" })).isAvailable("c")).toBe(true);
  });
});
