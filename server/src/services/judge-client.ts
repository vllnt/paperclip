import { createHash } from "node:crypto";
import {
  APICallError,
  createGateway,
  experimental_decide as decide,
  Experimental_DecisionRefusalError as DecisionRefusalError,
  type Experimental_DecisionQuestion as SdkQuestion,
  type JSONValue,
} from "ai";
import { lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { judgeUsageDaily } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** The only decision model this client talks to. Pinned on purpose; there is no override. */
export const JUDGE_MODEL_ID = "typesafe-ai/jev";

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_DAILY_CALL_CAP = 5_000;
const CACHE_MAX_ENTRIES = 5_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** A yes/no question answered with P(true). Abstains when P falls strictly inside `abstainBand`. */
export interface JudgePredicateQuestion {
  type: "predicate";
  instructions: string;
  whenTrue?: string;
  whenFalse?: string;
  abstainBand?: readonly [number, number];
}

/** A pick-one question. Abstains when the model's confidence is below `minConfidence`. */
export interface JudgeChoiceQuestion {
  type: "choice";
  instructions: string;
  options: Readonly<Record<string, string>>;
  minConfidence?: number;
}

/** An ordered rubric, lowest level first. Abstains when confidence is below `minConfidence`. */
export interface JudgeScoreQuestion {
  type: "score";
  instructions: string;
  levels: readonly string[];
  minConfidence?: number;
}

export type JudgeQuestion = JudgePredicateQuestion | JudgeChoiceQuestion | JudgeScoreQuestion;

export interface JudgePredicateAnswer {
  type: "predicate";
  probability: number | null;
  abstained: boolean;
}

export interface JudgeChoiceAnswer {
  type: "choice";
  choice: string | null;
  probabilities: Readonly<Record<string, number>> | null;
  confidence: number | null;
  abstained: boolean;
}

export interface JudgeScoreAnswer {
  type: "score";
  score: number | null;
  confidence: number | null;
  abstained: boolean;
}

export type JudgeAnswer = JudgePredicateAnswer | JudgeChoiceAnswer | JudgeScoreAnswer;

/** Shared state the questions are asked about. Keep it small: it is sent to the gateway. */
export interface JudgeState {
  readonly [key: string]: JSONValue;
}

export interface JudgeRequest {
  companyId: string;
  /** Bump when question wording changes so cached answers are not reused across rubrics. */
  rubricVersion: string;
  state: JudgeState;
  questions: Readonly<Record<string, JudgeQuestion>>;
}

export const JUDGE_FAILURE_REASONS = ["no_key", "cap_exceeded", "timeout", "error"] as const;
export type JudgeFailureReason = (typeof JUDGE_FAILURE_REASONS)[number];

export type JudgeOutcome =
  | {
      ok: true;
      answers: Readonly<Record<string, JudgeAnswer>>;
      modelId: string;
      inputHash: string;
      cached: boolean;
    }
  | { ok: false; reason: JudgeFailureReason; inputHash: string };

export interface JudgeClient {
  isConfigured(): boolean;
  /** Never throws: any failure comes back as `{ ok: false }` so callers fall back to deterministic checks. */
  ask(request: JudgeRequest): Promise<JudgeOutcome>;
}

type RawAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

export interface RawDecision {
  answers: Readonly<Record<string, RawAnswer>>;
  modelId: string;
  confidence: Readonly<Record<string, number>>;
}

export interface JudgeTransportCall {
  state: JudgeState;
  questions: Readonly<Record<string, SdkQuestion>>;
  signal: AbortSignal;
}

/** One request to the decision model. Throws on refusal, HTTP errors and aborts. */
export type JudgeTransport = (call: JudgeTransportCall) => Promise<RawDecision>;

/** Reserves one model call for a company; resolves false when the daily cap is spent. */
export interface JudgeUsageStore {
  reserve(companyId: string): Promise<boolean>;
}

export interface JudgeCache {
  get(key: string): { answers: Readonly<Record<string, JudgeAnswer>>; modelId: string } | undefined;
  set(key: string, value: { answers: Readonly<Record<string, JudgeAnswer>>; modelId: string }): void;
}

export interface JudgeConfig {
  apiKey: string | undefined;
  timeoutMs: number;
  dailyCallCap: number;
  zeroDataRetention: boolean;
}

class JudgeTimeoutError extends Error {
  constructor() {
    super("judge request timed out");
    this.name = "JudgeTimeoutError";
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JudgeTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Reads judge settings from the environment.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The key (when set), timeout, per-company daily call cap and zero-data-retention flag.
 */
export function readJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  return {
    apiKey: apiKey ? apiKey : undefined,
    timeoutMs: nonNegativeInteger(env.PAPERCLIP_JUDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    dailyCallCap: nonNegativeInteger(env.PAPERCLIP_JUDGE_DAILY_CALL_CAP, DEFAULT_DAILY_CALL_CAP),
    zeroDataRetention: env.PAPERCLIP_JUDGE_ZERO_DATA_RETENTION === "true",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hashes the exact input sent to the model: model id, rubric version, questions and state.
 * @returns A hex SHA-256 digest, stable across key order.
 */
export function hashJudgeInput(request: Pick<JudgeRequest, "rubricVersion" | "state" | "questions">): string {
  return createHash("sha256")
    .update(
      stableStringify({
        model: JUDGE_MODEL_ID,
        rubric: request.rubricVersion,
        questions: request.questions,
        state: request.state,
      }),
    )
    .digest("hex");
}

/** Bounded in-memory cache with a TTL. Oldest entries are evicted first. */
export function createJudgeCache(
  options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): JudgeCache {
  const maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { expiresAt: number; value: { answers: Readonly<Record<string, JudgeAnswer>>; modelId: string } }
  >();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { expiresAt: now() + ttlMs, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/**
 * Database-backed daily call counter. The increment is one atomic upsert, so concurrent
 * requests cannot overshoot the cap.
 * @param db - Database handle.
 * @param dailyCap - Maximum model calls per company per UTC day; 0 disables model calls.
 */
export function createJudgeUsageStore(
  db: Db,
  dailyCap: number,
  now: () => Date = () => new Date(),
): JudgeUsageStore {
  return {
    async reserve(companyId) {
      if (dailyCap <= 0) return false;
      const day = now().toISOString().slice(0, 10);
      const rows = await db
        .insert(judgeUsageDaily)
        .values({ companyId, day, calls: 1 })
        .onConflictDoUpdate({
          target: [judgeUsageDaily.companyId, judgeUsageDaily.day],
          set: { calls: sql`${judgeUsageDaily.calls} + 1`, updatedAt: new Date() },
          setWhere: lt(judgeUsageDaily.calls, dailyCap),
        })
        .returning({ calls: judgeUsageDaily.calls });
      return rows.length > 0;
    },
  };
}

function toSdkQuestion(question: JudgeQuestion): SdkQuestion {
  if (question.type === "predicate") {
    const criteria = {
      ...(question.whenTrue ? { true: question.whenTrue } : {}),
      ...(question.whenFalse ? { false: question.whenFalse } : {}),
    };
    return {
      type: "boolean",
      instructions: question.instructions,
      ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
    };
  }
  if (question.type === "choice") {
    return { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
  }
  return { type: "score", instructions: question.instructions, criteria: [...question.levels] };
}

function readConfidence(metadata: unknown): Record<string, number> {
  if (!isRecord(metadata)) return {};
  const typesafe = metadata.typesafe;
  if (!isRecord(typesafe) || !isRecord(typesafe.confidence)) return {};
  const confidence: Record<string, number> = {};
  for (const [questionId, value] of Object.entries(typesafe.confidence)) {
    if (typeof value === "number") confidence[questionId] = value;
  }
  return confidence;
}

/**
 * Builds the transport that calls `typesafe-ai/jev` through the Vercel AI Gateway with the AI SDK's
 * decision API (`experimental_decide`; `experimental_evaluate` is its deprecated alias).
 */
export function createGatewayTransport(options: { apiKey: string; zeroDataRetention: boolean }): JudgeTransport {
  const model = createGateway({ apiKey: options.apiKey }).decisionModel(JUDGE_MODEL_ID);
  return async ({ state, questions, signal }) => {
    const result = await decide({
      model,
      state,
      questions,
      maxRetries: 0,
      abortSignal: signal,
      ...(options.zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
    });
    return {
      answers: result.answers,
      modelId: result.response.modelId,
      confidence: readConfidence(result.providerMetadata),
    };
  };
}

function refusalAnswer(question: JudgeQuestion): JudgeAnswer {
  if (question.type === "predicate") return { type: "predicate", probability: null, abstained: true };
  if (question.type === "choice") {
    return { type: "choice", choice: null, probabilities: null, confidence: null, abstained: true };
  }
  return { type: "score", score: null, confidence: null, abstained: true };
}

function interpretAnswer(
  question: JudgeQuestion,
  raw: RawAnswer | undefined,
  confidence: number | undefined,
): JudgeAnswer | null {
  if (!raw) return null;
  if (question.type === "predicate" && raw.type === "boolean") {
    const [low, high] = question.abstainBand ?? [Number.NaN, Number.NaN];
    return {
      type: "predicate",
      probability: raw.probability,
      abstained: raw.probability > low && raw.probability < high,
    };
  }
  if (question.type === "choice" && raw.type === "choice") {
    const known = Object.hasOwn(question.options, raw.choice);
    return {
      type: "choice",
      choice: known ? raw.choice : null,
      probabilities: raw.probabilities ?? null,
      confidence: confidence ?? null,
      abstained: !known || (confidence !== undefined && confidence < (question.minConfidence ?? 0)),
    };
  }
  if (question.type === "score" && raw.type === "score") {
    return {
      type: "score",
      score: raw.score,
      confidence: confidence ?? null,
      abstained: confidence !== undefined && confidence < (question.minConfidence ?? 0),
    };
  }
  return null;
}

function describeFailure(error: unknown): Record<string, unknown> {
  if (APICallError.isInstance(error)) return { name: error.name, statusCode: error.statusCode };
  if (error instanceof Error) return { name: error.name };
  return { name: typeof error };
}

/**
 * Creates the decision-model client.
 *
 * Order of checks per call: missing key, content-hash cache, per-company daily cap, then one
 * gateway request under a hard timeout. Every failure returns `{ ok: false }`; nothing throws.
 */
export function createJudgeClient(options: {
  config: JudgeConfig;
  usage: JudgeUsageStore;
  cache?: JudgeCache;
  transport?: JudgeTransport;
}): JudgeClient {
  const { config, usage } = options;
  const cache = options.cache ?? createJudgeCache();
  const transport =
    options.transport ??
    (config.apiKey
      ? createGatewayTransport({ apiKey: config.apiKey, zeroDataRetention: config.zeroDataRetention })
      : null);

  async function callWithTimeout(request: JudgeRequest): Promise<RawDecision> {
    if (!transport) throw new Error("judge transport is not configured");
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new JudgeTimeoutError());
        controller.abort();
      }, config.timeoutMs);
    });
    const questions: Record<string, SdkQuestion> = {};
    for (const [id, question] of Object.entries(request.questions)) questions[id] = toSdkQuestion(question);
    try {
      return await Promise.race([transport({ state: request.state, questions, signal: controller.signal }), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured: () => transport !== null,
    async ask(request) {
      const inputHash = hashJudgeInput(request);
      if (!transport) return { ok: false, reason: "no_key", inputHash };

      const cacheKey = `${request.companyId}:${inputHash}`;
      const hit = cache.get(cacheKey);
      if (hit) return { ok: true, answers: hit.answers, modelId: hit.modelId, inputHash, cached: true };

      try {
        if (!(await withTimeout(usage.reserve(request.companyId), config.timeoutMs))) {
          return { ok: false, reason: "cap_exceeded", inputHash };
        }
      } catch (error) {
        logger.warn({ companyId: request.companyId, ...describeFailure(error) }, "judge usage reservation failed");
        return { ok: false, reason: error instanceof JudgeTimeoutError ? "timeout" : "error", inputHash };
      }

      const startedAt = Date.now();
      try {
        const raw = await callWithTimeout(request);
        const answers: Record<string, JudgeAnswer> = {};
        for (const [id, question] of Object.entries(request.questions)) {
          const answer = interpretAnswer(question, raw.answers[id], raw.confidence[id]);
          if (!answer) throw new Error(`judge returned no usable answer for question "${id}"`);
          answers[id] = answer;
        }
        cache.set(cacheKey, { answers, modelId: raw.modelId });
        return { ok: true, answers, modelId: raw.modelId, inputHash, cached: false };
      } catch (error) {
        if (DecisionRefusalError.isInstance(error)) {
          const answers: Record<string, JudgeAnswer> = {};
          for (const [id, question] of Object.entries(request.questions)) answers[id] = refusalAnswer(question);
          return { ok: true, answers, modelId: error.modelId, inputHash, cached: false };
        }
        logger.warn(
          { companyId: request.companyId, elapsedMs: Date.now() - startedAt, ...describeFailure(error) },
          "judge request failed; falling back to deterministic checks",
        );
        return { ok: false, reason: error instanceof JudgeTimeoutError ? "timeout" : "error", inputHash };
      }
    },
  };
}
