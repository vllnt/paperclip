import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  decide: vi.fn(),
  decisionModel: vi.fn(),
  createGateway: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  sdk.createGateway.mockImplementation(() => ({ decisionModel: sdk.decisionModel }));
  return { ...actual, createGateway: sdk.createGateway, experimental_decide: sdk.decide };
});

import {
  JUDGE_MODEL_ID,
  createGatewayTransport,
  createJudgeCache,
  createJudgeClient,
  hashJudgeInput,
  readJudgeConfig,
  type JudgeConfig,
  type JudgeQuestion,
  type JudgeTransport,
} from "../services/judge-client.js";

const COMPANY = "00000000-0000-0000-0000-00000000000a";
const OTHER_COMPANY = "00000000-0000-0000-0000-00000000000b";

const config: JudgeConfig = { apiKey: "test-key", timeoutMs: 50, dailyCallCap: 10, zeroDataRetention: false };

const questions: Record<string, JudgeQuestion> = {
  same_outcome: {
    type: "predicate",
    instructions: "Same result?",
    abstainBand: [0.3, 0.9],
  },
};

const state = { new_issue: { title: "A", description: "" }, existing_issue: { title: "B", description: "" } };

function request(overrides: { companyId?: string; rubricVersion?: string } = {}) {
  return { companyId: COMPANY, rubricVersion: "v1", state, questions, ...overrides };
}

function transportReturning(probability: number, modelId = "typesafe-ai/jev-1.2"): JudgeTransport {
  return vi.fn(async () => ({
    answers: { same_outcome: { type: "boolean" as const, probability } },
    modelId,
    confidence: {},
  }));
}

const allowAll = { reserve: vi.fn(async () => true) };

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createGateway.mockImplementation(() => ({ decisionModel: sdk.decisionModel }));
});

describe("judge client", () => {
  it("fails open without an API key and never calls the gateway", async () => {
    const transport = transportReturning(0.99);
    const client = createJudgeClient({ config: { ...config, apiKey: undefined }, usage: allowAll });
    const outcome = await client.ask(request());
    expect(outcome).toMatchObject({ ok: false, reason: "no_key" });
    expect(client.isConfigured()).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(sdk.createGateway).not.toHaveBeenCalled();
  });

  it("returns a typed predicate answer and the resolved model id", async () => {
    const client = createJudgeClient({ config, usage: allowAll, transport: transportReturning(0.95) });
    const outcome = await client.ask(request());
    expect(outcome).toMatchObject({ ok: true, cached: false, modelId: "typesafe-ai/jev-1.2" });
    if (!outcome.ok) return;
    expect(outcome.answers.same_outcome).toEqual({ type: "predicate", probability: 0.95, abstained: false });
  });

  it("abstains inside the uncertain band but keeps the probability", async () => {
    const client = createJudgeClient({ config, usage: allowAll, transport: transportReturning(0.6) });
    const outcome = await client.ask(request());
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.answers.same_outcome).toEqual({ type: "predicate", probability: 0.6, abstained: true });
  });

  it("does not abstain at the band edges", async () => {
    for (const probability of [0.3, 0.9]) {
      const client = createJudgeClient({ config, usage: allowAll, transport: transportReturning(probability) });
      const outcome = await client.ask(request());
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.answers.same_outcome).toMatchObject({ abstained: false });
    }
  });

  it("abstains on low-confidence choices and on unknown options", async () => {
    const choiceQuestions: Record<string, JudgeQuestion> = {
      kind: { type: "choice", instructions: "Kind?", options: { bug: "defect", chore: "upkeep" }, minConfidence: 0.7 },
    };
    const lowConfidence = createJudgeClient({
      config,
      usage: allowAll,
      transport: async () => ({
        answers: { kind: { type: "choice", choice: "bug" } },
        modelId: "m",
        confidence: { kind: 0.4 },
      }),
    });
    const low = await lowConfidence.ask({ ...request(), questions: choiceQuestions });
    if (!low.ok) throw new Error("expected ok");
    expect(low.answers.kind).toMatchObject({ choice: "bug", confidence: 0.4, abstained: true });

    const unknownOption = createJudgeClient({
      config,
      usage: allowAll,
      transport: async () => ({
        answers: { kind: { type: "choice", choice: "feature" } },
        modelId: "m",
        confidence: { kind: 0.99 },
      }),
    });
    const unknown = await unknownOption.ask({ ...request(), questions: choiceQuestions });
    if (!unknown.ok) throw new Error("expected ok");
    expect(unknown.answers.kind).toMatchObject({ choice: null, abstained: true });
  });

  it("serves identical input from the cache without a second call or reservation", async () => {
    const transport = transportReturning(0.5);
    const usage = { reserve: vi.fn(async () => true) };
    const client = createJudgeClient({ config, usage, transport });
    const first = await client.ask(request());
    const second = await client.ask(request());
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(usage.reserve).toHaveBeenCalledTimes(1);
  });

  it("does not share cached answers across companies or rubric versions", async () => {
    const transport = transportReturning(0.5);
    const client = createJudgeClient({ config, usage: allowAll, transport });
    await client.ask(request());
    await client.ask(request({ companyId: OTHER_COMPANY }));
    await client.ask(request({ rubricVersion: "v2" }));
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("reserves usage per company and stops at the cap without calling the model", async () => {
    const transport = transportReturning(0.5);
    const spent = new Set([COMPANY]);
    const usage = { reserve: vi.fn(async (companyId: string) => !spent.has(companyId)) };
    const client = createJudgeClient({ config, usage, transport });
    const capped = await client.ask(request());
    const other = await client.ask(request({ companyId: OTHER_COMPANY }));
    expect(capped).toMatchObject({ ok: false, reason: "cap_exceeded" });
    expect(other.ok).toBe(true);
    expect(usage.reserve).toHaveBeenNthCalledWith(1, COMPANY);
    expect(usage.reserve).toHaveBeenNthCalledWith(2, OTHER_COMPANY);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("fails open on a hung gateway after the timeout", async () => {
    const transport: JudgeTransport = vi.fn(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const client = createJudgeClient({ config, usage: allowAll, transport });
    const startedAt = Date.now();
    const outcome = await client.ask(request());
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails open when the cap reservation hangs", async () => {
    const transport = transportReturning(0.5);
    const client = createJudgeClient({ config, usage: { reserve: () => new Promise<boolean>(() => {}) }, transport });
    expect(await client.ask(request())).toMatchObject({ ok: false, reason: "timeout" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails open when the gateway throws or the usage store is down", async () => {
    const failing = createJudgeClient({
      config,
      usage: allowAll,
      transport: async () => {
        throw new Error("401 unauthorized");
      },
    });
    expect(await failing.ask(request())).toMatchObject({ ok: false, reason: "error" });

    const usageDown = createJudgeClient({
      config,
      usage: { reserve: async () => { throw new Error("db down"); } },
      transport: transportReturning(0.5),
    });
    expect(await usageDown.ask(request())).toMatchObject({ ok: false, reason: "error" });
  });

  it("treats a missing or mismatched answer as an error rather than guessing", async () => {
    const client = createJudgeClient({
      config,
      usage: allowAll,
      transport: async () => ({ answers: {}, modelId: "m", confidence: {} }),
    });
    expect(await client.ask(request())).toMatchObject({ ok: false, reason: "error" });
  });

  it("does not cache failures, so a later call can succeed", async () => {
    let calls = 0;
    const client = createJudgeClient({
      config,
      usage: allowAll,
      transport: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { answers: { same_outcome: { type: "boolean", probability: 0.1 } }, modelId: "m", confidence: {} };
      },
    });
    expect((await client.ask(request())).ok).toBe(false);
    expect((await client.ask(request())).ok).toBe(true);
  });
});

describe("hashJudgeInput", () => {
  it("is stable across key order and changes with any input", () => {
    const a = hashJudgeInput({ rubricVersion: "v1", state: { x: 1, y: { b: 2, a: 1 } }, questions });
    const b = hashJudgeInput({ rubricVersion: "v1", state: { y: { a: 1, b: 2 }, x: 1 }, questions });
    expect(a).toBe(b);
    expect(hashJudgeInput({ rubricVersion: "v2", state: { x: 1, y: { b: 2, a: 1 } }, questions })).not.toBe(a);
    expect(hashJudgeInput({ rubricVersion: "v1", state: { x: 2, y: { b: 2, a: 1 } }, questions })).not.toBe(a);
  });
});

describe("judge cache", () => {
  it("expires entries and evicts the oldest past its size", () => {
    let now = 0;
    const cache = createJudgeCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    const value = { answers: {}, modelId: "m" };
    cache.set("a", value);
    cache.set("b", value);
    cache.set("c", value);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(value);
    now = 101;
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("readJudgeConfig", () => {
  it("reads the gateway key and falls back to safe defaults", () => {
    expect(readJudgeConfig({})).toEqual({
      apiKey: undefined,
      timeoutMs: 4_000,
      dailyCallCap: 5_000,
      zeroDataRetention: false,
    });
    expect(
      readJudgeConfig({
        AI_GATEWAY_API_KEY: " key ",
        PAPERCLIP_JUDGE_TIMEOUT_MS: "1500",
        PAPERCLIP_JUDGE_DAILY_CALL_CAP: "0",
        PAPERCLIP_JUDGE_ZERO_DATA_RETENTION: "true",
      }),
    ).toEqual({ apiKey: "key", timeoutMs: 1_500, dailyCallCap: 0, zeroDataRetention: true });
    expect(readJudgeConfig({ PAPERCLIP_JUDGE_TIMEOUT_MS: "nope" }).timeoutMs).toBe(4_000);
  });
});

describe("gateway transport (mocked AI SDK)", () => {
  it("asks the pinned Jev model through the gateway decision API", async () => {
    sdk.decisionModel.mockReturnValue({ modelId: JUDGE_MODEL_ID });
    sdk.decide.mockResolvedValue({
      answers: { same_outcome: { type: "boolean", probability: 0.42 } },
      response: { modelId: "typesafe-ai/jev-1.2" },
      providerMetadata: { typesafe: { confidence: { kind: 0.8, ignored: "x" } } },
    });
    const transport = createGatewayTransport({ apiKey: "secret-key", zeroDataRetention: false });
    const signal = new AbortController().signal;

    const result = await transport({
      state,
      signal,
      questions: { same_outcome: { type: "boolean", instructions: "Same result?" } },
    });

    expect(sdk.createGateway).toHaveBeenCalledWith({ apiKey: "secret-key" });
    expect(sdk.decisionModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(sdk.decide).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, abortSignal: signal, state }),
    );
    expect(sdk.decide.mock.calls[0]?.[0]).not.toHaveProperty("providerOptions");
    expect(result).toEqual({
      answers: { same_outcome: { type: "boolean", probability: 0.42 } },
      modelId: "typesafe-ai/jev-1.2",
      confidence: { kind: 0.8 },
    });
  });

  it("requests zero data retention only when configured", async () => {
    sdk.decisionModel.mockReturnValue({});
    sdk.decide.mockResolvedValue({ answers: {}, response: { modelId: "m" }, providerMetadata: undefined });
    await createGatewayTransport({ apiKey: "k", zeroDataRetention: true })({
      state,
      questions: {},
      signal: new AbortController().signal,
    });
    expect(sdk.decide).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { gateway: { zeroDataRetention: true } } }),
    );
  });

  it("maps typed questions to SDK questions and treats a refusal as an abstain", async () => {
    sdk.decisionModel.mockReturnValue({});
    const { Experimental_DecisionRefusalError: Refusal } = await import("ai");
    sdk.decide.mockRejectedValue(new Refusal({ questionIds: ["same_outcome"], provider: "gateway", modelId: "typesafe-ai/jev-1.2" }));
    const client = createJudgeClient({ config, usage: allowAll });

    const outcome = await client.ask({
      ...request(),
      questions: {
        same_outcome: { type: "predicate", instructions: "Same?", whenTrue: "yes", whenFalse: "no" },
        kind: { type: "choice", instructions: "Kind?", options: { bug: "defect" } },
        size: { type: "score", instructions: "Size?", levels: ["small", "large"] },
      },
    });

    expect(sdk.decide.mock.calls[0]?.[0].questions).toEqual({
      same_outcome: { type: "boolean", instructions: "Same?", criteria: { true: "yes", false: "no" } },
      kind: { type: "choice", instructions: "Kind?", criteria: { bug: "defect" } },
      size: { type: "score", instructions: "Size?", criteria: ["small", "large"] },
    });
    if (!outcome.ok) throw new Error("a refusal is an abstain, not a failure");
    expect(outcome.answers.same_outcome).toEqual({ type: "predicate", probability: null, abstained: true });
    expect(outcome.answers.kind).toMatchObject({ choice: null, abstained: true });
    expect(outcome.answers.size).toMatchObject({ score: null, abstained: true });
  });
});
