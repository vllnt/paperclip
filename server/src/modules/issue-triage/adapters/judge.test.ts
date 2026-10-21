import { describe, expect, it } from "vitest";
import {
  createJudgeCache,
  createJudgeClient,
  type JudgeTransport,
} from "../../../services/judge-client.js";
import { createJudgeTriageModel } from "./judge.js";

const request = {
  companyId: "company-1",
  rubricVersion: "issue-triage-test",
  state: { issue: { title: "Fix the login redirect loop", description: "" } },
  questions: {
    category: {
      type: "choice" as const,
      instructions: "Which category?",
      options: { bug: "Broken", feature: "New" },
    },
  },
};

function model(transport: JudgeTransport, options: { reserve?: boolean; key?: string } = {}) {
  return createJudgeTriageModel(
    createJudgeClient({
      config: { timeoutMs: 1_000, dailyCallCap: 10, zeroDataRetention: false },
      usage: { reserve: async () => options.reserve ?? true },
      resolveApiKey: async () => options.key,
      cache: createJudgeCache(),
      transportFor: () => transport,
    }),
  );
}

describe("createJudgeTriageModel", () => {
  it("maps a choice answer to its choice and probabilities", async () => {
    const outcome = await model(
      async () => ({
        answers: { category: { type: "choice", choice: "bug", probabilities: { bug: 0.9, feature: 0.1 } } },
        modelId: "typesafe-ai/jev",
        confidence: { category: 0.9 },
      }),
      { key: "k" },
    ).ask(request);
    expect(outcome).toMatchObject({ ok: true, modelId: "typesafe-ai/jev", cached: false });
    expect(outcome.ok && outcome.answers.category).toEqual({ choice: "bug", probabilities: { bug: 0.9, feature: 0.1 } });
  });

  it("drops a choice that was not offered", async () => {
    const outcome = await model(
      async () => ({
        answers: { category: { type: "choice", choice: "invented", probabilities: { invented: 1 } } },
        modelId: "typesafe-ai/jev",
        confidence: {},
      }),
      { key: "k" },
    ).ask(request);
    expect(outcome.ok && outcome.answers.category?.choice).toBeNull();
  });

  it("reports a missing key without calling the gateway", async () => {
    let called = false;
    const outcome = await model(async () => {
      called = true;
      throw new Error("must not be called");
    }).ask(request);
    expect(outcome).toMatchObject({ ok: false, reason: "no_key" });
    expect(called).toBe(false);
  });

  it("reports a spent daily cap without calling the gateway", async () => {
    let called = false;
    const outcome = await model(
      async () => {
        called = true;
        throw new Error("must not be called");
      },
      { reserve: false, key: "k" },
    ).ask(request);
    expect(outcome).toMatchObject({ ok: false, reason: "cap_exceeded" });
    expect(called).toBe(false);
  });

  it("reports a transport error as an error", async () => {
    const outcome = await model(
      async () => {
        throw new Error("gateway down");
      },
      { key: "k" },
    ).ask(request);
    expect(outcome).toMatchObject({ ok: false, reason: "error" });
  });
});
