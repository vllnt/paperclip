import { createHash } from "node:crypto";
import { Experimental_DecisionRefusalError as DecisionRefusalError } from "ai";
import {
  companyEvalInputSchemaSchema,
  companyEvalQuestionsSchema,
  createCompanyEvalSchema,
  createCompanyEvalVersionSchema,
  type CompanyEvalAgentView,
  type CompanyEvalAnswer,
  type CompanyEvalDetail,
  type CompanyEvalPage,
  type CreateCompanyEval,
  type RunCompanyEval,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { createJudgeAdapter } from "../modules/evals/adapters/judge.js";
import type {
  EvalsRepository,
  EvalsRuntime,
  ListEvalsQuery,
  NewEvalFields,
  NewFeedbackFields,
  RunContextPort,
} from "../modules/evals/application/ports.js";
import {
  EvalInputRejectedError,
  EvalSlugTakenError,
  EvalsApplicationError,
  type EvalActor,
  type EvalRecord,
  type FeedbackRecord,
  type NewRunRecord,
  type NewVersionFields,
  type RunRecord,
  type VerifiedRunContext,
  type VersionRecord,
} from "../modules/evals/application/types.js";
import { createEvalsService, sweepExpiredEvalInputs } from "../modules/evals/application/use-cases.js";
import { canonicalJson } from "../modules/evals/domain/canonical.js";
import { encodeCursor } from "../modules/evals/domain/cursor.js";
import { redactSensitiveText } from "../redaction.js";
import {
  createJudgeClient,
  type JudgeTransport,
  type JudgeTransportCall,
  type JudgeUsage,
  type RawDecision,
} from "../services/judge-client.js";

const COMPANY = "00000000-0000-4000-8000-00000000000a";
const OTHER_COMPANY = "00000000-0000-4000-8000-00000000000b";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HEARTBEAT_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const BOARD: EvalActor = { type: "user", userId: "board-user" };
const OTHER_BOARD: EvalActor = { type: "user", userId: "other-board-user" };
const AGENT: EvalActor = { type: "agent", agentId: AGENT_ID };
const OTHER_AGENT: EvalActor = { type: "agent", agentId: OTHER_AGENT_ID };

const SLUG = "pr-preview-needs-qa";
const START = "2026-10-09T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const LATENCY_MS = 120;
const NO_KEY_HINT = "Add the company secret AI_GATEWAY_API_KEY";
const CANARY = "CANARY-value-must-not-be-echoed";

/** A token-shaped value for the redaction tests, built at runtime so no scanner sees a literal. */
const TOKEN_CORE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const TOKEN = `${["gh", "p_"].join("")}${TOKEN_CORE}`;
const MASK = "***REDACTED***";
/** Inputs over this many bytes are refused before they are scanned for secrets: 32 times the input cap. */
const MAX_SCANNED_INPUT_BYTES = 32 * 32_768;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

function definition(overrides: Partial<CreateCompanyEval> = {}): CreateCompanyEval {
  return createCompanyEvalSchema.parse({
    slug: SLUG,
    title: "PR preview needs QA",
    whenToUse: "Before asking for a QA pass on a preview deployment.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        labels: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
        files_changed: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: ["bug", "feature"] },
      },
      required: ["title"],
    },
    questions: {
      needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?" },
      qa_depth: {
        type: "choice",
        instructions: "How deep should the QA pass be?",
        options: { none: "No QA", smoke: "A smoke test", full_qa: "A full QA pass" },
      },
    },
    ...overrides,
  });
}

/** Overrides for an eval with one free-text property that may be as long as the input cap allows. */
function bodyOverrides(slug: string): Partial<CreateCompanyEval> {
  return {
    slug,
    inputSchema: companyEvalInputSchemaSchema.parse({
      type: "object",
      properties: { body: { type: "string", maxLength: 32_768 } },
      required: ["body"],
    }),
  };
}

/** A second definition: the same shape with different question wording. */
function reworded(): CreateCompanyEval {
  return definition({
    questions: companyEvalQuestionsSchema.parse({
      needs_qa: { type: "predicate", instructions: "Would a person want to test this preview?" },
      qa_depth: {
        type: "choice",
        instructions: "How deep should the QA pass be?",
        options: { none: "No QA", smoke: "A smoke test", full_qa: "A full QA pass" },
      },
    }),
  });
}

/** Overrides for an eval with one predicate question that abstains between 0.3 and 0.7. */
function bandedOverrides(slug: string): Partial<CreateCompanyEval> {
  return {
    slug,
    questions: companyEvalQuestionsSchema.parse({
      needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?", abstainBand: [0.3, 0.7] },
    }),
  };
}

function versionBody(source: CreateCompanyEval) {
  return createCompanyEvalVersionSchema.parse({ inputSchema: source.inputSchema, questions: source.questions });
}

// ---------------------------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------------------------

function createClock(start: string) {
  let wall = Date.parse(start);
  let monotonic = 1_000;
  return {
    now: (): Date => new Date(wall),
    monotonicMs: (): number => monotonic,
    advanceWall(ms: number): void {
      wall += ms;
    },
    advanceMonotonic(ms: number): void {
      monotonic += ms;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

function createRuntime(clock: Clock, redactions: { calls: number }): EvalsRuntime {
  let counter = 0;
  return {
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    newId: () => {
      counter += 1;
      return `11111111-1111-4111-8111-${counter.toString(16).padStart(12, "0")}`;
    },
    sha256Hex: sha256,
    redactText: (text) => {
      redactions.calls += 1;
      return redactSensitiveText(text);
    },
  };
}

interface FakeRepo extends EvalsRepository {
  readonly evals: EvalRecord[];
  readonly versions: VersionRecord[];
  readonly runs: RunRecord[];
  readonly feedback: FeedbackRecord[];
  readonly appendCalls: Array<{ expectedLatest: number }>;
  readonly clearCalls: number[];
  /** The next `count` appends lose the race: a competing writer takes the version number first. */
  loseNextAppends(count: number, options?: { competitorSavesSameDefinition?: boolean }): void;
  failNextInsertWithSlugTaken(): void;
}

function createFakeRepo(): FakeRepo {
  const evals: EvalRecord[] = [];
  const versions: VersionRecord[] = [];
  const runs: RunRecord[] = [];
  const feedback: FeedbackRecord[] = [];
  const appendCalls: Array<{ expectedLatest: number }> = [];
  const clearCalls: number[] = [];
  let pendingLosses = 0;
  let competitorUsesSameDefinition = false;
  let competitors = 0;
  let slugRace = false;

  function evalOf(companyId: string, evalId: string): EvalRecord | undefined {
    return evals.find((row) => row.companyId === companyId && row.id === evalId);
  }

  function commitVersion(record: EvalRecord, fields: NewVersionFields): VersionRecord {
    const created: VersionRecord = {
      id: fields.id,
      companyId: record.companyId,
      evalId: record.id,
      versionNumber: record.latestVersionNumber + 1,
      inputSchema: fields.inputSchema,
      questions: fields.questions,
      definitionHash: fields.definitionHash,
      changeNote: fields.changeNote,
      createdByUserId: fields.createdByUserId,
      createdAt: fields.createdAt,
    };
    versions.push(created);
    record.latestVersionNumber = created.versionNumber;
    record.updatedAt = fields.createdAt;
    return structuredClone(created);
  }

  function newEvalRecord(fields: NewEvalFields): EvalRecord {
    return {
      id: fields.id,
      companyId: fields.companyId,
      slug: fields.slug,
      title: fields.title,
      whenToUse: fields.whenToUse,
      status: "draft",
      publishedVersionId: null,
      latestVersionNumber: 0,
      templateKey: null,
      templateVersion: null,
      createdByUserId: fields.createdByUserId,
      updatedByUserId: fields.createdByUserId,
      createdAt: fields.now,
      updatedAt: fields.now,
      publishedAt: null,
      archivedAt: null,
    };
  }

  return {
    evals,
    versions,
    runs,
    feedback,
    appendCalls,
    clearCalls,
    loseNextAppends(count, options) {
      pendingLosses = count;
      competitorUsesSameDefinition = options?.competitorSavesSameDefinition ?? false;
    },
    failNextInsertWithSlugTaken() {
      slugRace = true;
    },

    async findEvalBySlug(companyId, slug) {
      const found = evals.find((row) => row.companyId === companyId && row.slug === slug);
      return found ? structuredClone(found) : null;
    },

    async listEvals(companyId, query: ListEvalsQuery) {
      return evals
        .filter((row) => row.companyId === companyId)
        .filter((row) => query.statuses.includes(row.status))
        .filter((row) => !query.publishedOnly || row.publishedVersionId !== null)
        .filter((row) => query.afterSlug === undefined || row.slug > query.afterSlug)
        .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
        .slice(0, query.limit)
        .map((row) => structuredClone(row));
    },

    async insertEvalWithFirstVersion(fields, version) {
      if (slugRace) {
        slugRace = false;
        throw new EvalSlugTakenError(fields.slug);
      }
      if (evals.some((row) => row.companyId === fields.companyId && row.slug === fields.slug)) {
        throw new EvalSlugTakenError(fields.slug);
      }
      const record = newEvalRecord(fields);
      evals.push(record);
      const first = commitVersion(record, version);
      return { eval: structuredClone(record), version: first };
    },

    async updateEvalMeta(companyId, evalId, patch) {
      const record = evalOf(companyId, evalId);
      if (!record) return null;
      if (patch.title !== undefined) record.title = patch.title;
      if (patch.whenToUse !== undefined) record.whenToUse = patch.whenToUse;
      record.updatedByUserId = patch.updatedByUserId;
      record.updatedAt = patch.now;
      return structuredClone(record);
    },

    async getVersionByNumber(companyId, evalId, versionNumber) {
      const found = versions.find(
        (row) => row.companyId === companyId && row.evalId === evalId && row.versionNumber === versionNumber,
      );
      return found ? structuredClone(found) : null;
    },

    async getVersionsByIds(companyId, ids) {
      return versions.filter((row) => row.companyId === companyId && ids.includes(row.id)).map((row) => structuredClone(row));
    },

    async listVersions(companyId, evalId, query) {
      return versions
        .filter((row) => row.companyId === companyId && row.evalId === evalId)
        .filter((row) => query.beforeNumber === undefined || row.versionNumber < query.beforeNumber)
        .sort((left, right) => right.versionNumber - left.versionNumber)
        .slice(0, query.limit)
        .map((row) => structuredClone(row));
    },

    async appendVersion(input) {
      appendCalls.push({ expectedLatest: input.expectedLatest });
      const record = evalOf(input.companyId, input.evalId);
      if (!record) return null;
      if (pendingLosses > 0) {
        pendingLosses -= 1;
        competitors += 1;
        commitVersion(record, {
          ...input.version,
          id: `competitor-${competitors}`,
          definitionHash: competitorUsesSameDefinition ? input.version.definitionHash : `competitor-hash-${competitors}`,
        });
        return null;
      }
      if (record.latestVersionNumber !== input.expectedLatest) return null;
      return commitVersion(record, input.version);
    },

    async setPublished(companyId, evalId, input) {
      const record = evalOf(companyId, evalId);
      if (!record) return null;
      record.status = "published";
      record.publishedVersionId = input.versionId;
      record.publishedAt = input.now;
      record.archivedAt = null;
      record.updatedByUserId = input.updatedByUserId;
      record.updatedAt = input.now;
      return structuredClone(record);
    },

    async setArchived(companyId, evalId, input) {
      const record = evalOf(companyId, evalId);
      if (!record) return null;
      record.status = "archived";
      record.archivedAt = input.now;
      record.updatedByUserId = input.updatedByUserId;
      record.updatedAt = input.now;
      return structuredClone(record);
    },

    async deleteNeverPublished(companyId, evalId) {
      const record = evalOf(companyId, evalId);
      if (!record || record.publishedAt !== null) return false;
      const runIds = new Set(runs.filter((row) => row.evalId === evalId).map((row) => row.id));
      removeWhere(feedback, (row) => runIds.has(row.runId));
      removeWhere(runs, (row) => row.evalId === evalId);
      removeWhere(versions, (row) => row.evalId === evalId);
      removeWhere(evals, (row) => row.id === evalId);
      return true;
    },

    async insertRun(run: NewRunRecord) {
      runs.push(structuredClone(run));
      return structuredClone(run);
    },

    async listRuns(companyId, evalId, query) {
      const { filter, after } = query;
      return runs
        .filter((row) => row.companyId === companyId && row.evalId === evalId)
        .filter((row) => filter.from === undefined || row.createdAt >= filter.from)
        .filter((row) => filter.to === undefined || row.createdAt <= filter.to)
        .filter((row) => filter.versionNumber === undefined || row.versionNumber === filter.versionNumber)
        .filter((row) => filter.agentId === undefined || row.callerAgentId === filter.agentId)
        .filter((row) => filter.projectId === undefined || row.projectId === filter.projectId)
        .filter((row) => filter.outcome === undefined || row.outcome === filter.outcome)
        .filter((row) => filter.mode === undefined || row.mode === filter.mode)
        .filter((row) => {
          if (!after) return true;
          const afterMs = new Date(after.at).getTime();
          return row.createdAt.getTime() < afterMs || (row.createdAt.getTime() === afterMs && row.id < after.id);
        })
        .sort((left, right) => {
          const byTime = right.createdAt.getTime() - left.createdAt.getTime();
          if (byTime !== 0) return byTime;
          return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
        })
        .slice(0, query.limit)
        .map((row) => structuredClone(row));
    },

    async getRun(companyId, evalId, runId) {
      const found = runs.find((row) => row.companyId === companyId && row.evalId === evalId && row.id === runId);
      return found ? structuredClone(found) : null;
    },

    async upsertFeedback(fields: NewFeedbackFields) {
      const existing = feedback.find(
        (row) => row.runId === fields.runId && row.questionKey === fields.questionKey && row.authorKey === fields.authorKey,
      );
      if (existing) {
        existing.verdict = fields.verdict;
        existing.note = fields.note;
        existing.updatedAt = fields.now;
        return structuredClone(existing);
      }
      const created: FeedbackRecord = {
        id: fields.id,
        companyId: fields.companyId,
        runId: fields.runId,
        questionKey: fields.questionKey,
        verdict: fields.verdict,
        note: fields.note,
        authorType: fields.authorType,
        authorKey: fields.authorKey,
        authorAgentId: fields.authorAgentId,
        authorUserId: fields.authorUserId,
        createdAt: fields.now,
        updatedAt: fields.now,
      };
      feedback.push(created);
      return structuredClone(created);
    },

    async listFeedback(companyId, runId) {
      return feedback.filter((row) => row.companyId === companyId && row.runId === runId).map((row) => structuredClone(row));
    },

    async clearExpiredInputs(now, batchSize) {
      clearCalls.push(batchSize);
      const expired = runs
        .filter((row) => row.input !== null && row.inputExpiresAt !== null && row.inputExpiresAt <= now)
        .sort((left, right) => (left.inputExpiresAt?.getTime() ?? 0) - (right.inputExpiresAt?.getTime() ?? 0))
        .slice(0, batchSize);
      for (const row of expired) row.input = null;
      return expired.length;
    },
  };
}

function removeWhere<T>(rows: T[], predicate: (row: T) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && predicate(row)) rows.splice(index, 1);
  }
}

interface FakeRunContext extends RunContextPort {
  readonly calls: Array<{ companyId: string; actor: EvalActor; runId: string | null; issueId: string | null }>;
  next: VerifiedRunContext;
}

function createFakeRunContext(): FakeRunContext {
  const calls: FakeRunContext["calls"] = [];
  const context: FakeRunContext = {
    calls,
    next: { heartbeatRunId: null, issueId: null, projectId: null, requestedIssueMissing: false },
    async verify(input) {
      calls.push({ companyId: input.companyId, actor: input.actor, runId: input.runId, issueId: input.issueId });
      return context.next;
    },
  };
  return context;
}

/** A decision for the default definition: one predicate and one choice question. */
function decision(options: { needsQa?: number; usage?: JudgeUsage; costUsd?: number } = {}): RawDecision {
  return {
    answers: {
      needs_qa: { type: "boolean", probability: options.needsQa ?? 0.91 },
      qa_depth: { type: "choice", choice: "smoke", probabilities: { none: 0.05, smoke: 0.71, full_qa: 0.24 } },
    },
    modelId: "typesafe-ai/jev-test",
    confidence: { qa_depth: 0.71 },
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.costUsd !== undefined ? { costUsd: options.costUsd } : {}),
  };
}

function hangUntilAborted(call: JudgeTransportCall): Promise<RawDecision> {
  return new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

interface HarnessOptions {
  retentionDays?: number;
  dailyCallCap?: number;
}

/**
 * The evals service wired to the real Jev client. Only the edges are fake: the gateway transport,
 * the daily usage store, the company key lookup, the storage and the run-id check.
 */
function harness(options: HarnessOptions = {}) {
  const clock = createClock(START);
  const repo = createFakeRepo();
  const runContext = createFakeRunContext();
  const redactions = { calls: 0 };
  const runtime = createRuntime(clock, redactions);

  const transportCalls: JudgeTransportCall[] = [];
  const gateway: { respond: (call: JudgeTransportCall) => Promise<RawDecision> } = {
    respond: async () => decision(),
  };
  const transport: JudgeTransport = async (call) => {
    transportCalls.push(call);
    clock.advanceMonotonic(LATENCY_MS);
    return gateway.respond(call);
  };

  const keys = new Map<string, string>([
    [COMPANY, "key-for-company-a"],
    [OTHER_COMPANY, "key-for-company-b"],
  ]);
  const reservations = new Map<string, number>();
  const cap = options.dailyCallCap ?? 1_000;
  const usage = {
    reserve: async (companyId: string): Promise<boolean> => {
      const used = (reservations.get(companyId) ?? 0) + 1;
      if (used > cap) return false;
      reservations.set(companyId, used);
      return true;
    },
  };

  const judge = createJudgeClient({
    config: { timeoutMs: 25, dailyCallCap: cap, zeroDataRetention: false },
    usage,
    resolveApiKey: async (companyId) => keys.get(companyId),
    transportFor: () => transport,
  });

  const service = createEvalsService({
    repo,
    judge: createJudgeAdapter(judge),
    runContext,
    runtime,
    settings: { inputRetentionDays: options.retentionDays ?? 30 },
  });

  return { service, repo, runContext, runtime, clock, gateway, keys, reservations, transportCalls, redactions };
}

type Harness = ReturnType<typeof harness>;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The board reads the whole eval; an agent reads a narrower view without the latest version. */
function boardDetail(view: CompanyEvalAgentView | CompanyEvalDetail): CompanyEvalDetail {
  if (!("latestVersion" in view)) throw new Error("expected the board detail, got the agent view");
  return view;
}

async function failure(promise: Promise<unknown>): Promise<EvalsApplicationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EvalsApplicationError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

async function rejection(promise: Promise<unknown>): Promise<EvalInputRejectedError> {
  const error = await failure(promise);
  if (!(error instanceof EvalInputRejectedError)) throw new Error(`expected a rejected input, got ${error.code}`);
  return error;
}

async function createDraft(h: Harness, overrides: Partial<CreateCompanyEval> = {}, companyId = COMPANY) {
  return h.service.create(BOARD, companyId, definition(overrides));
}

async function createPublished(h: Harness, overrides: Partial<CreateCompanyEval> = {}, companyId = COMPANY) {
  const created = await createDraft(h, overrides, companyId);
  await h.service.publish(BOARD, companyId, created.slug, {});
  return created;
}

function runBody(input: unknown, extra: Partial<RunCompanyEval> = {}): RunCompanyEval {
  return { input, ...extra };
}

function run(h: Harness, actor: EvalActor, input: unknown, extra: Partial<RunCompanyEval> = {}, slug = SLUG) {
  return h.service.run(actor, COMPANY, slug, runBody(input, extra), { runId: null });
}

function lastRun(h: Harness): RunRecord {
  const row = h.repo.runs.at(-1);
  if (!row) throw new Error("no run row was stored");
  return row;
}

function slugsOf(page: CompanyEvalPage<{ slug: string }>): string[] {
  return page.items.map((item) => item.slug);
}

function answerOf(answers: Record<string, CompanyEvalAnswer> | null, questionId: string): CompanyEvalAnswer {
  const answer = answers?.[questionId];
  if (!answer) throw new Error(`no answer for ${questionId}`);
  return answer;
}

// A compile-time check: the storage port has no method that updates a version.
type VersionMethod = Extract<keyof EvalsRepository, `${string}ersion${string}`>;
const VERSION_METHODS_THAT_ONLY_READ_OR_ADD = [
  "appendVersion",
  "getVersionByNumber",
  "getVersionsByIds",
  "insertEvalWithFirstVersion",
  "listVersions",
] as const;
type UnlistedVersionMethod = Exclude<VersionMethod, (typeof VERSION_METHODS_THAT_ONLY_READ_OR_ADD)[number]>;
const portHasNoVersionUpdate: [UnlistedVersionMethod] extends [never] ? true : never = true;

// ---------------------------------------------------------------------------------------------

describe("company evals service", () => {
  describe("company isolation", () => {
    const operations: Array<[string, (h: Harness) => Promise<unknown>]> = [
      ["get", (h) => h.service.get(BOARD, OTHER_COMPANY, SLUG)],
      ["update", (h) => h.service.update(BOARD, OTHER_COMPANY, SLUG, { title: "Hijacked" })],
      ["createVersion", (h) => h.service.createVersion(BOARD, OTHER_COMPANY, SLUG, versionBody(reworded()))],
      ["listVersions", (h) => h.service.listVersions(BOARD, OTHER_COMPANY, SLUG, { limit: 10 })],
      ["getVersion", (h) => h.service.getVersion(BOARD, OTHER_COMPANY, SLUG, 1)],
      ["publish", (h) => h.service.publish(BOARD, OTHER_COMPANY, SLUG, {})],
      ["archive", (h) => h.service.archive(BOARD, OTHER_COMPANY, SLUG)],
      ["remove", (h) => h.service.remove(BOARD, OTHER_COMPANY, SLUG)],
      ["run as board", (h) => h.service.run(BOARD, OTHER_COMPANY, SLUG, runBody({ title: "x" }), { runId: null })],
      ["run as agent", (h) => h.service.run(AGENT, OTHER_COMPANY, SLUG, runBody({ title: "x" }), { runId: null })],
      ["listRuns", (h) => h.service.listRuns(BOARD, OTHER_COMPANY, SLUG, { limit: 10 })],
      ["getRun", (h) => h.service.getRun(BOARD, OTHER_COMPANY, SLUG, "11111111-1111-4111-8111-000000000099")],
      [
        "putFeedback",
        (h) => h.service.putFeedback(BOARD, OTHER_COMPANY, SLUG, "11111111-1111-4111-8111-000000000099", { verdict: "correct" }),
      ],
    ];

    it.each(operations)("%s on another company's eval is not found", async (_name, operation) => {
      const h = harness();
      await createPublished(h);
      const before = h.repo.runs.length;
      const error = await failure(operation(h));
      expect(error.code).toBe("not_found");
      expect(h.repo.runs).toHaveLength(before);
      expect(h.transportCalls).toHaveLength(0);
      expect(h.repo.evals).toHaveLength(1);
    });

    it("does not show another company's list", async () => {
      const h = harness();
      await createPublished(h);
      expect(slugsOf(await h.service.list(BOARD, OTHER_COMPANY, { limit: 10 }))).toEqual([]);
      expect(slugsOf(await h.service.list(AGENT, OTHER_COMPANY, { limit: 10 }))).toEqual([]);
    });

    it("keeps the runs and feedback of two companies with the same slug apart", async () => {
      const h = harness();
      await createPublished(h);
      await createPublished(h, {}, OTHER_COMPANY);
      const result = await run(h, BOARD, { title: "From company A" });
      await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct" });

      const otherRuns = await h.service.listRuns(BOARD, OTHER_COMPANY, SLUG, { limit: 10 });
      expect(otherRuns.items).toEqual([]);
      expect((await failure(h.service.getRun(BOARD, OTHER_COMPANY, SLUG, result.runId))).code).toBe("not_found");
      expect(
        (await failure(h.service.putFeedback(BOARD, OTHER_COMPANY, SLUG, result.runId, { verdict: "incorrect" }))).code,
      ).toBe("not_found");
      expect(h.repo.feedback).toHaveLength(1);
      expect(h.repo.feedback[0]?.verdict).toBe("correct");
    });

    it("does not find a run through the slug of a different eval", async () => {
      const h = harness();
      await createPublished(h);
      await createPublished(h, { slug: "second-eval" });
      const result = await run(h, BOARD, { title: "x" });
      expect((await failure(h.service.getRun(BOARD, COMPANY, "second-eval", result.runId))).code).toBe("not_found");
      expect(
        (await failure(h.service.putFeedback(BOARD, COMPANY, "second-eval", result.runId, { verdict: "correct" }))).code,
      ).toBe("not_found");
    });
  });

  describe("who may author and who may see", () => {
    const authoring: Array<[string, (h: Harness, actor: EvalActor) => Promise<unknown>]> = [
      ["create", (h, actor) => h.service.create(actor, COMPANY, definition({ slug: "agent-made" }))],
      ["update", (h, actor) => h.service.update(actor, COMPANY, SLUG, { title: "New title" })],
      ["createVersion", (h, actor) => h.service.createVersion(actor, COMPANY, SLUG, versionBody(reworded()))],
      ["listVersions", (h, actor) => h.service.listVersions(actor, COMPANY, SLUG, { limit: 10 })],
      ["getVersion", (h, actor) => h.service.getVersion(actor, COMPANY, SLUG, 1)],
      ["publish", (h, actor) => h.service.publish(actor, COMPANY, SLUG, {})],
      ["archive", (h, actor) => h.service.archive(actor, COMPANY, SLUG)],
      ["remove", (h, actor) => h.service.remove(actor, COMPANY, SLUG)],
    ];

    it.each(authoring)("an agent cannot %s", async (_name, operation) => {
      const h = harness();
      await createPublished(h);
      const before = JSON.stringify([h.repo.evals, h.repo.versions]);
      const error = await failure(operation(h, AGENT));
      expect(error.code).toBe("forbidden");
      expect(JSON.stringify([h.repo.evals, h.repo.versions])).toBe(before);
    });

    it("refuses an agent before it looks the eval up, so a missing slug is forbidden too", async () => {
      const h = harness();
      expect((await failure(h.service.publish(AGENT, COMPANY, "no-such-eval", {}))).code).toBe("forbidden");
    });

    it("hides a draft eval from an agent in every read, run and mark", async () => {
      const h = harness();
      const created = await createDraft(h);
      const boardRun = await run(h, BOARD, { title: "x" });
      for (const operation of [
        () => h.service.get(AGENT, COMPANY, SLUG),
        () => run(h, AGENT, { title: "x" }),
        () => h.service.listRuns(AGENT, COMPANY, SLUG, { limit: 10 }),
        () => h.service.getRun(AGENT, COMPANY, SLUG, boardRun.runId),
        () => h.service.putFeedback(AGENT, COMPANY, SLUG, boardRun.runId, { verdict: "correct" }),
      ]) {
        expect((await failure(operation())).code).toBe("not_found");
      }
      expect(created.status).toBe("draft");
      expect(h.repo.runs).toHaveLength(1);
    });

    it("lists only published evals for an agent, as a view without the questions", async () => {
      const h = harness();
      await createDraft(h, { slug: "a-draft" });
      await createPublished(h, { slug: "b-live" });
      await createPublished(h, { slug: "c-retired" });
      await h.service.archive(BOARD, COMPANY, "c-retired");

      const page = await h.service.list(AGENT, COMPANY, { limit: 10 });
      expect(slugsOf(page)).toEqual(["b-live"]);
      expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(["id", "publishedVersion", "slug", "title", "whenToUse"]);
      expect(JSON.stringify(page)).not.toContain("Does this change need a QA pass?");
      expect(JSON.stringify(page)).not.toContain("questions");
      const published = page.items[0];
      expect(published && "publishedVersion" in published ? published.publishedVersion.versionNumber : null).toBe(1);
    });

    it("ignores the status filter for an agent", async () => {
      const h = harness();
      await createDraft(h, { slug: "a-draft" });
      await createPublished(h, { slug: "b-live" });
      expect(slugsOf(await h.service.list(AGENT, COMPANY, { limit: 10, status: "draft" }))).toEqual(["b-live"]);
    });

    it("lists draft and published evals for the board, and archived ones on request", async () => {
      const h = harness();
      await createDraft(h, { slug: "a-draft" });
      await createPublished(h, { slug: "b-live" });
      await createPublished(h, { slug: "c-retired" });
      await h.service.archive(BOARD, COMPANY, "c-retired");

      expect(slugsOf(await h.service.list(BOARD, COMPANY, { limit: 10 }))).toEqual(["a-draft", "b-live"]);
      expect(slugsOf(await h.service.list(BOARD, COMPANY, { limit: 10, status: "archived" }))).toEqual(["c-retired"]);
      expect(slugsOf(await h.service.list(BOARD, COMPANY, { limit: 10, status: "published" }))).toEqual(["b-live"]);
      expect(slugsOf(await h.service.list(BOARD, COMPANY, { limit: 10, status: "draft" }))).toEqual(["a-draft"]);
    });

    it("pages the eval list by slug", async () => {
      const h = harness();
      for (const slug of ["eval-a", "eval-b", "eval-c", "eval-d", "eval-e"]) await createDraft(h, { slug });
      const first = await h.service.list(BOARD, COMPANY, { limit: 2 });
      const second = await h.service.list(BOARD, COMPANY, { limit: 2, cursor: first.nextCursor ?? undefined });
      const third = await h.service.list(BOARD, COMPANY, { limit: 2, cursor: second.nextCursor ?? undefined });
      expect(slugsOf(first)).toEqual(["eval-a", "eval-b"]);
      expect(slugsOf(second)).toEqual(["eval-c", "eval-d"]);
      expect(slugsOf(third)).toEqual(["eval-e"]);
      expect(third.nextCursor).toBeNull();
    });

    it("rejects a list cursor that is not valid", async () => {
      const h = harness();
      expect((await failure(h.service.list(BOARD, COMPANY, { limit: 10, cursor: "garbage" }))).code).toBe("invalid_request");
    });

    it("shows an agent the published version only, and stops once the eval is archived", async () => {
      const h = harness();
      await createPublished(h);
      await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
      const view = await h.service.get(AGENT, COMPANY, SLUG);
      expect(view.publishedVersion?.versionNumber).toBe(1);
      expect("questions" in view).toBe(false);
      expect("latestVersion" in view).toBe(false);

      await h.service.archive(BOARD, COMPANY, SLUG);
      expect((await failure(h.service.get(AGENT, COMPANY, SLUG))).code).toBe("not_found");
      expect((await failure(run(h, AGENT, { title: "x" }))).code).toBe("not_found");
    });

    it("shows the board both the published and the latest version", async () => {
      const h = harness();
      await createPublished(h);
      await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
      const detail = boardDetail(await h.service.get(BOARD, COMPANY, SLUG));
      expect(detail.latestVersion?.versionNumber).toBe(2);
      expect(detail.publishedVersion?.versionNumber).toBe(1);
      expect(detail.latestVersion).toHaveProperty("questions");
    });
  });

  describe("authoring", () => {
    it("creates a draft with version 1 and the hash of its definition", async () => {
      const h = harness();
      const created = await createDraft(h);
      expect(created).toMatchObject({
        slug: SLUG,
        status: "draft",
        companyId: COMPANY,
        publishedVersionId: null,
        publishedVersionNumber: null,
        latestVersionNumber: 1,
        createdByUserId: "board-user",
      });
      expect(created.publishedVersion).toBeNull();
      expect(created.latestVersion?.versionNumber).toBe(1);
      const body = definition();
      const expected = sha256(canonicalJson({ inputSchema: body.inputSchema, questions: body.questions }));
      expect(created.latestVersion?.definitionHash).toBe(expected);
    });

    it("refuses a slug that is already taken in the company", async () => {
      const h = harness();
      await createDraft(h);
      const error = await failure(createDraft(h));
      expect(error.code).toBe("conflict");
      expect(error.details).toEqual({ code: "eval_slug_taken" });
      expect(h.repo.evals).toHaveLength(1);
    });

    it("maps a slug race lost in storage to the same conflict", async () => {
      const h = harness();
      h.repo.failNextInsertWithSlugTaken();
      const error = await failure(createDraft(h));
      expect(error).toMatchObject({ code: "conflict", details: { code: "eval_slug_taken" } });
    });

    it("lets two companies use the same slug", async () => {
      const h = harness();
      await createDraft(h);
      await createDraft(h, {}, OTHER_COMPANY);
      expect(h.repo.evals).toHaveLength(2);
    });

    it("updates the title and whenToUse and records who did it", async () => {
      const h = harness();
      await createPublished(h);
      h.clock.advanceWall(1_000);
      const updated = await h.service.update(OTHER_BOARD, COMPANY, SLUG, { title: "New title" });
      expect(updated).toMatchObject({
        title: "New title",
        whenToUse: "Before asking for a QA pass on a preview deployment.",
        updatedByUserId: "other-board-user",
        publishedVersionNumber: 1,
        status: "published",
      });
      expect(updated.updatedAt).toBe("2026-10-09T12:00:01.000Z");
      const changed = await h.service.update(BOARD, COMPANY, SLUG, { whenToUse: "A new reason" });
      expect(changed).toMatchObject({ title: "New title", whenToUse: "A new reason" });
    });

    describe("versions", () => {
      it("does not create a version for an identical definition and returns the latest one", async () => {
        const h = harness();
        const created = await createDraft(h);
        const result = await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(definition()));
        expect(result.created).toBe(false);
        expect(result.version.id).toBe(created.latestVersion?.id);
        expect(result.version.versionNumber).toBe(1);
        expect(h.repo.versions).toHaveLength(1);
        expect(boardDetail(await h.service.get(BOARD, COMPANY, SLUG)).latestVersionNumber).toBe(1);
      });

      it("treats key order and the change note as no change", async () => {
        const h = harness();
        await createDraft(h);
        const source = definition();
        const reordered = createCompanyEvalVersionSchema.parse({
          questions: Object.fromEntries(Object.entries(source.questions).reverse()),
          inputSchema: {
            required: source.inputSchema.required,
            properties: Object.fromEntries(Object.entries(source.inputSchema.properties).reverse()),
            type: "object",
          },
          changeNote: "Only a note changed",
        });
        const result = await h.service.createVersion(BOARD, COMPANY, SLUG, reordered);
        expect(result.created).toBe(false);
        expect(h.repo.versions).toHaveLength(1);
      });

      it("creates the next version when the definition changes, and keeps the older one as it was", async () => {
        const h = harness();
        await createDraft(h);
        const firstSnapshot = JSON.stringify(h.repo.versions[0]);
        h.clock.advanceWall(1_000);
        const result = await h.service.createVersion(BOARD, COMPANY, SLUG, {
          ...versionBody(reworded()),
          changeNote: "Clearer wording",
        });
        expect(result.created).toBe(true);
        expect(result.version).toMatchObject({ versionNumber: 2, changeNote: "Clearer wording", createdByUserId: "board-user" });
        expect(h.repo.versions).toHaveLength(2);
        expect(JSON.stringify(h.repo.versions[0])).toBe(firstSnapshot);
        expect(boardDetail(await h.service.get(BOARD, COMPANY, SLUG)).latestVersionNumber).toBe(2);
      });

      it("compares with the latest version only, so going back to an older definition is a new version", async () => {
        const h = harness();
        await createDraft(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        const back = await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(definition()));
        expect(back.created).toBe(true);
        expect(back.version.versionNumber).toBe(3);
        expect(back.version.definitionHash).toBe(h.repo.versions[0]?.definitionHash);
      });

      it("has no way to update a version", () => {
        const h = harness();
        expect(portHasNoVersionUpdate).toBe(true);
        expect(Object.keys(h.service).filter((name) => /version/i.test(name)).sort()).toEqual([
          "createVersion",
          "getVersion",
          "listVersions",
        ]);
      });

      it("retries a lost race with the version number the competing writer left", async () => {
        const h = harness();
        await createDraft(h);
        h.repo.loseNextAppends(1);
        const result = await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        expect(result.created).toBe(true);
        expect(result.version.versionNumber).toBe(3);
        expect(h.repo.appendCalls).toEqual([{ expectedLatest: 1 }, { expectedLatest: 2 }]);
        expect(h.repo.versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
      });

      it("returns the competing version when the other writer saved the same definition", async () => {
        const h = harness();
        await createDraft(h);
        h.repo.loseNextAppends(1, { competitorSavesSameDefinition: true });
        const result = await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        expect(result.created).toBe(false);
        expect(result.version.versionNumber).toBe(2);
        expect(h.repo.versions).toHaveLength(2);
      });

      it("gives up with a conflict after three lost races", async () => {
        const h = harness();
        await createDraft(h);
        h.repo.loseNextAppends(3);
        const error = await failure(h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded())));
        expect(error.code).toBe("conflict");
        expect(error.details).toEqual({ code: "eval_version_conflict" });
        expect(h.repo.appendCalls).toHaveLength(3);
        expect(h.repo.versions.every((version) => version.id === h.repo.versions[0]?.id || version.id.startsWith("competitor-"))).toBe(
          true,
        );
      });

      it("lists versions newest first and pages them with a cursor", async () => {
        const h = harness();
        await createDraft(h);
        for (let step = 1; step <= 4; step += 1) {
          await h.service.createVersion(
            BOARD,
            COMPANY,
            SLUG,
            versionBody(
              definition({
                questions: companyEvalQuestionsSchema.parse({
                  needs_qa: { type: "predicate", instructions: `Wording number ${step}` },
                }),
              }),
            ),
          );
        }
        const first = await h.service.listVersions(BOARD, COMPANY, SLUG, { limit: 2 });
        const second = await h.service.listVersions(BOARD, COMPANY, SLUG, { limit: 2, cursor: first.nextCursor ?? undefined });
        const third = await h.service.listVersions(BOARD, COMPANY, SLUG, { limit: 2, cursor: second.nextCursor ?? undefined });
        expect(first.items.map((version) => version.versionNumber)).toEqual([5, 4]);
        expect(second.items.map((version) => version.versionNumber)).toEqual([3, 2]);
        expect(third.items.map((version) => version.versionNumber)).toEqual([1]);
        expect(third.nextCursor).toBeNull();
      });

      it("rejects a version cursor that is not valid or has the wrong shape", async () => {
        const h = harness();
        await createDraft(h);
        await createDraft(h, { slug: "other-eval" });
        const evalPage = await h.service.list(BOARD, COMPANY, { limit: 1 });
        expect(evalPage.nextCursor).not.toBeNull();
        for (const cursor of ["garbage", evalPage.nextCursor ?? ""]) {
          expect((await failure(h.service.listVersions(BOARD, COMPANY, SLUG, { limit: 10, cursor }))).code).toBe("invalid_request");
        }
      });

      it("reads one version by number and says not found for a number that does not exist", async () => {
        const h = harness();
        await createDraft(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        expect((await h.service.getVersion(BOARD, COMPANY, SLUG, 2)).versionNumber).toBe(2);
        expect((await failure(h.service.getVersion(BOARD, COMPANY, SLUG, 3))).code).toBe("not_found");
      });
    });

    describe("publish, archive and delete", () => {
      it("publishes the latest version by default and a named version on request", async () => {
        const h = harness();
        const created = await createDraft(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        const latest = await h.service.publish(BOARD, COMPANY, SLUG, {});
        expect(latest).toMatchObject({ status: "published", publishedVersionNumber: 2 });
        const older = await h.service.publish(BOARD, COMPANY, SLUG, { versionNumber: 1 });
        expect(older).toMatchObject({ status: "published", publishedVersionNumber: 1, publishedVersionId: created.latestVersion?.id });
        expect(older.publishedAt).not.toBeNull();
      });

      it("says not found when the version to publish does not exist", async () => {
        const h = harness();
        await createDraft(h);
        expect((await failure(h.service.publish(BOARD, COMPANY, SLUG, { versionNumber: 5 }))).code).toBe("not_found");
        expect(h.repo.evals[0]?.status).toBe("draft");
      });

      it("archives an eval and restores it when it is published again", async () => {
        const h = harness();
        await createPublished(h);
        const archived = await h.service.archive(BOARD, COMPANY, SLUG);
        expect(archived).toMatchObject({ status: "archived", publishedVersionNumber: 1 });
        expect(archived.archivedAt).not.toBeNull();
        const restored = await h.service.publish(BOARD, COMPANY, SLUG, {});
        expect(restored).toMatchObject({ status: "published", archivedAt: null });
        expect(slugsOf(await h.service.list(AGENT, COMPANY, { limit: 10 }))).toEqual([SLUG]);
      });


      it("deletes an eval that was never published, with its versions, try-it runs and feedback", async () => {
        const h = harness();
        const created = await createDraft(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        const tryIt = await run(h, BOARD, { title: "x" });
        expect(tryIt.mode).toBe("try_it");
        await h.service.putFeedback(BOARD, COMPANY, SLUG, tryIt.runId, { verdict: "correct" });

        const removed = await h.service.remove(BOARD, COMPANY, SLUG);
        expect(removed).toEqual({ id: created.id, slug: SLUG });
        expect([h.repo.evals, h.repo.versions, h.repo.runs, h.repo.feedback].map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
        expect((await failure(h.service.get(BOARD, COMPANY, SLUG))).code).toBe("not_found");
      });

      it("deletes a draft that was archived without ever being published", async () => {
        const h = harness();
        await createDraft(h);
        await h.service.archive(BOARD, COMPANY, SLUG);
        await h.service.remove(BOARD, COMPANY, SLUG);
        expect(h.repo.evals).toHaveLength(0);
      });

      it("refuses to delete a published eval and keeps it with its runs", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, { title: "x" });
        const error = await failure(h.service.remove(BOARD, COMPANY, SLUG));
        expect(error).toMatchObject({ code: "conflict", details: { code: "eval_has_history" } });
        expect(h.repo.evals).toHaveLength(1);
        expect(h.repo.runs).toHaveLength(1);
      });

      it("refuses to delete an archived eval that was published once", async () => {
        const h = harness();
        await createPublished(h);
        await h.service.archive(BOARD, COMPANY, SLUG);
        const error = await failure(h.service.remove(BOARD, COMPANY, SLUG));
        expect(error).toMatchObject({ code: "conflict", details: { code: "eval_has_history" } });
        expect(h.repo.evals).toHaveLength(1);
      });
    });
  });

  describe("running an eval", () => {
    it("answers, records the call and returns the run result", async () => {
      const h = harness();
      const created = await createPublished(h);
      const input = { title: "Fix login" };
      const result = await run(h, AGENT, input);

      expect(result).toMatchObject({
        eval: { id: created.id, slug: SLUG, versionId: created.latestVersion?.id, versionNumber: 1 },
        outcome: "answered",
        failureReason: null,
        cached: false,
        latencyMs: LATENCY_MS,
        modelId: "typesafe-ai/jev-test",
        mode: "live",
      });
      expect("hint" in result).toBe(false);
      expect(answerOf(result.answers, "qa_depth")).toEqual({
        type: "choice",
        choice: "smoke",
        probabilities: { none: 0.05, smoke: 0.71, full_qa: 0.24 },
        confidence: 0.71,
        abstained: false,
      });

      const row = lastRun(h);
      expect(result.runId).toBe(row.id);
      expect(row).toMatchObject({
        companyId: COMPANY,
        evalId: created.id,
        versionId: created.latestVersion?.id,
        versionNumber: 1,
        callerType: "agent",
        callerAgentId: AGENT_ID,
        callerUserId: null,
        outcome: "answered",
        failureReason: null,
        mode: "live",
        anyAbstained: false,
        cached: false,
        latencyMs: LATENCY_MS,
        modelId: "typesafe-ai/jev-test",
        inputHash: sha256(JSON.stringify(input)),
        inputRedacted: false,
        inputRedactionCount: 0,
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        input,
        inputExpiresAt: new Date("2026-11-08T12:00:00.000Z"),
      });
    });

    it("records a board call under the user", async () => {
      const h = harness();
      await createPublished(h);
      await run(h, BOARD, { title: "x" });
      expect(lastRun(h)).toMatchObject({ callerType: "user", callerUserId: "board-user", callerAgentId: null, mode: "live" });
    });

    it("sends the version's questions and the input to the judge, one call per run", async () => {
      const h = harness();
      await createPublished(h);
      await run(h, AGENT, { title: "Fix login", labels: ["bug"] });
      expect(h.transportCalls).toHaveLength(1);
      const call = h.transportCalls[0];
      expect(call?.state).toEqual({ title: "Fix login", labels: ["bug"] });
      expect(Object.keys(call?.questions ?? {}).sort()).toEqual(["needs_qa", "qa_depth"]);
      expect(call?.questions.needs_qa).toMatchObject({ type: "boolean", instructions: "Does this change need a QA pass?" });
      expect(call?.questions.qa_depth).toMatchObject({ type: "choice", criteria: { none: "No QA", smoke: "A smoke test" } });
    });

    describe("predicate answers carry a value", () => {
      it.each([
        [0.5, true],
        [0.91, true],
        [1, true],
        [0.4999, false],
        [0, false],
      ])("a probability of %s gives value %s", async (probability, value) => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => decision({ needsQa: probability });
        const result = await run(h, AGENT, { title: "x" });
        expect(answerOf(result.answers, "needs_qa")).toEqual({ type: "predicate", probability, value, abstained: false });
        expect(lastRun(h).answers).toEqual(result.answers);
      });

      it("gives value null when the answer abstained, and keeps the probability", async () => {
        const h = harness();
        await createPublished(h, bandedOverrides("banded"));
        h.gateway.respond = async () => decision({ needsQa: 0.6 });
        const result = await run(h, AGENT, { title: "x" }, {}, "banded");
        expect(answerOf(result.answers, "needs_qa")).toEqual({ type: "predicate", probability: 0.6, value: null, abstained: true });
        expect(lastRun(h).anyAbstained).toBe(true);
      });

      it("gives no value to a choice answer", async () => {
        const h = harness();
        await createPublished(h);
        const result = await run(h, AGENT, { title: "x" });
        expect("value" in answerOf(result.answers, "qa_depth")).toBe(false);
      });
    });

    describe("an input that is rejected", () => {
      it("rejects an input over 32 KiB, records it without the input and never calls the judge", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const input = { body: filler(32_758) };
        const bytes = Buffer.byteLength(JSON.stringify(input));
        expect(bytes).toBe(32_769);

        const error = await rejection(run(h, AGENT, input, {}, "big-body"));
        expect(error.code).toBe("input_rejected");
        expect(error.rejection).toMatchObject({
          code: "eval_input_too_large",
          maxInputBytes: 32_768,
          inputBytes: bytes,
        });
        const row = lastRun(h);
        expect(error.rejection.runId).toBe(row.id);
        expect(row).toMatchObject({
          outcome: "rejected",
          failureReason: "input_too_large",
          latencyMs: 0,
          input: null,
          inputExpiresAt: null,
          inputBytes: bytes,
          answers: null,
          anyAbstained: false,
          cached: false,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          callerAgentId: AGENT_ID,
          mode: "live",
        });
        expect(h.transportCalls).toHaveLength(0);
        expect(h.reservations.size).toBe(0);
        expect(JSON.stringify([row, error.rejection])).not.toContain("lorem");
      });

      it("accepts an input of exactly 32 KiB", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const input = { body: filler(32_757) };
        expect(Buffer.byteLength(JSON.stringify(input))).toBe(32_768);
        const result = await run(h, AGENT, input, {}, "big-body");
        expect(result.outcome).toBe("answered");
        expect(h.transportCalls).toHaveLength(1);
      });

      it("counts bytes, not characters", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const fits = { body: "é".repeat(16_000) };
        expect((await run(h, AGENT, fits, {}, "big-body")).outcome).toBe("answered");

        const tooBig = { body: "é".repeat(16_400) };
        const error = await rejection(run(h, AGENT, tooBig, {}, "big-body"));
        expect(error.rejection).toMatchObject({ code: "eval_input_too_large", inputBytes: Buffer.byteLength(JSON.stringify(tooBig)) });
        expect(h.transportCalls).toHaveLength(1);
      });

      it("rejects an input over 1 MiB before any redaction or schema check, and hashes only its size", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const input = { body: `${TOKEN} ${"x".repeat(MAX_SCANNED_INPUT_BYTES)}` };
        const bytes = Buffer.byteLength(JSON.stringify(input));
        expect(bytes).toBeGreaterThan(MAX_SCANNED_INPUT_BYTES);

        const error = await rejection(run(h, AGENT, input, {}, "big-body"));
        expect(error.rejection).toMatchObject({ code: "eval_input_too_large", maxInputBytes: 32_768, inputBytes: bytes });
        const row = lastRun(h);
        expect(error.rejection.runId).toBe(row.id);
        expect(row).toMatchObject({
          outcome: "rejected",
          failureReason: "input_too_large",
          latencyMs: 0,
          input: null,
          inputExpiresAt: null,
          inputBytes: bytes,
          inputRedacted: false,
          inputRedactionCount: 0,
          inputHash: sha256(`company-eval-input:too-large:${bytes}`),
        });
        expect(row.inputHash).not.toBe(sha256(JSON.stringify(input)));
        expect(row.inputHash).not.toBe(sha256(JSON.stringify({ body: `${MASK} ${"x".repeat(MAX_SCANNED_INPUT_BYTES)}` })));
        expect(h.redactions.calls).toBe(0);
        expect(h.transportCalls).toHaveLength(0);
        expect(JSON.stringify([row, error.rejection])).not.toContain(TOKEN_CORE);
      });

      it("still redacts and hashes the redacted text of an input of exactly 1 MiB", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const rest = filler(MAX_SCANNED_INPUT_BYTES - 11 - TOKEN.length - 1);
        const input = { body: `${TOKEN} ${rest}` };
        expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_SCANNED_INPUT_BYTES);

        await rejection(run(h, AGENT, input, {}, "big-body"));
        expect(h.redactions.calls).toBeGreaterThan(0);
        expect(lastRun(h)).toMatchObject({
          failureReason: "input_too_large",
          inputRedacted: true,
          inputRedactionCount: 1,
          inputHash: sha256(JSON.stringify({ body: `${MASK} ${rest}` })),
        });
      });

      it("reports the size first when an input is both too large and not valid", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const error = await rejection(run(h, AGENT, { body: filler(40_000) }, {}, "big-body"));
        expect(error.rejection.code).toBe("eval_input_too_large");
      });

      it("rejects an input that does not match the schema, with paths and messages and no values", async () => {
        const h = harness();
        await createPublished(h);
        const input = { extra: CANARY, kind: CANARY, title: 42 };
        const error = await rejection(run(h, BOARD, input));
        expect(error.rejection.code).toBe("eval_input_invalid");
        expect(error.rejection.errors).toEqual(
          expect.arrayContaining([
            { path: "/title", message: "must be string" },
            { path: "/kind", message: "must be equal to one of the allowed values" },
            { path: "/", message: "must NOT have additional properties: extra" },
          ]),
        );
        const row = lastRun(h);
        expect(error.rejection.runId).toBe(row.id);
        expect(row).toMatchObject({
          outcome: "rejected",
          failureReason: "input_invalid",
          latencyMs: 0,
          input: null,
          inputExpiresAt: null,
          inputBytes: Buffer.byteLength(JSON.stringify(input)),
          inputHash: sha256(JSON.stringify(input)),
          answers: null,
          callerType: "user",
        });
        expect(JSON.stringify([row, error.rejection, error.message])).not.toContain(CANARY);
        expect(h.transportCalls).toHaveLength(0);
      });

      it("reports a missing required property", async () => {
        const h = harness();
        await createPublished(h);
        const error = await rejection(run(h, AGENT, {}));
        expect(error.rejection.errors).toEqual([{ path: "/", message: "must have required property 'title'" }]);
      });

      it.each([
        ["an array", ["a"]],
        ["a string", "title"],
        ["a number", 7],
        ["null", null],
      ])("rejects %s in place of an object", async (_name, input) => {
        const h = harness();
        await createPublished(h);
        const error = await rejection(run(h, AGENT, input));
        expect(error.rejection.errors).toEqual([{ path: "/", message: "must be object" }]);
        expect(lastRun(h)).toMatchObject({ outcome: "rejected", failureReason: "input_invalid", latencyMs: 0, input: null });
      });

      it("rejects an input that is nested too deeply, without walking it", async () => {
        const h = harness();
        await createPublished(h);
        let nested: unknown = "leaf";
        for (let level = 0; level < 50_000; level += 1) nested = { v: nested };
        const error = await rejection(run(h, AGENT, { title: "x", labels: nested }));
        expect(error.rejection.errors).toEqual([{ path: "/", message: "is nested too deeply" }]);
        expect(lastRun(h)).toMatchObject({
          outcome: "rejected",
          failureReason: "input_invalid",
          inputBytes: 0,
          inputHash: sha256("company-eval-input:too-deep"),
          input: null,
          latencyMs: 0,
        });
        expect(h.transportCalls).toHaveLength(0);
      });

      it("stores the rejected run with the run id, issue and project that the check verified", async () => {
        const h = harness();
        await createPublished(h);
        h.runContext.next = { heartbeatRunId: HEARTBEAT_RUN_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, requestedIssueMissing: false };
        await rejection(run(h, AGENT, { title: 5 }));
        expect(lastRun(h)).toMatchObject({ heartbeatRunId: HEARTBEAT_RUN_ID, issueId: ISSUE_ID, projectId: PROJECT_ID });
      });
    });

    describe("a failure of the judge is a recorded failed run and never a guessed answer", () => {
      const failures: Array<[string, HarnessOptions, (h: Harness) => void]> = [
        ["no_key", {}, (h) => void h.keys.delete(COMPANY)],
        ["cap_exceeded", { dailyCallCap: 0 }, () => undefined],
        [
          "timeout",
          {},
          (h) => {
            h.gateway.respond = hangUntilAborted;
          },
        ],
        [
          "error",
          {},
          (h) => {
            h.gateway.respond = async () => {
              throw new Error("the gateway is down");
            };
          },
        ],
      ];

      it.each(failures)("%s", async (reason, options, setup) => {
        const h = harness(options);
        await createPublished(h);
        setup(h);
        const input = { title: "Fix login" };
        const result = await run(h, AGENT, input);

        expect(result).toMatchObject({ outcome: "failed", failureReason: reason, answers: null, cached: false, modelId: null });
        expect(result.runId).toBe(lastRun(h).id);
        expect(lastRun(h)).toMatchObject({
          outcome: "failed",
          failureReason: reason,
          answers: null,
          anyAbstained: false,
          cached: false,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          input,
          inputHash: sha256(JSON.stringify(input)),
          mode: "live",
        });
        expect(h.repo.runs).toHaveLength(1);
        if (reason === "no_key") {
          expect(result.hint).toBe(NO_KEY_HINT);
        } else {
          expect("hint" in result).toBe(false);
        }
        if (reason === "no_key" || reason === "cap_exceeded") expect(h.transportCalls).toHaveLength(0);
      });

      it("sends nothing to the gateway for a company without a key", async () => {
        const h = harness();
        await createPublished(h);
        h.keys.delete(COMPANY);
        await run(h, AGENT, { title: "x" });
        expect(h.transportCalls).toHaveLength(0);
        expect(h.reservations.size).toBe(0);
      });

      it("does not cache a failure: the next call asks the judge again", async () => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => {
          throw new Error("the gateway is down");
        };
        expect((await run(h, AGENT, { title: "x" })).outcome).toBe("failed");
        h.gateway.respond = async () => decision();
        const retry = await run(h, AGENT, { title: "x" });
        expect(retry).toMatchObject({ outcome: "answered", cached: false });
        expect(h.transportCalls).toHaveLength(2);
      });

      it("stops at the company's daily cap but still serves a cached answer", async () => {
        const h = harness({ dailyCallCap: 1 });
        await createPublished(h);
        const first = await run(h, AGENT, { title: "first" });
        const second = await run(h, AGENT, { title: "second" });
        const repeat = await run(h, AGENT, { title: "first" });
        expect(first.outcome).toBe("answered");
        expect(second).toMatchObject({ outcome: "failed", failureReason: "cap_exceeded" });
        expect(repeat).toMatchObject({ outcome: "answered", cached: true });
        expect(h.transportCalls).toHaveLength(1);
      });

      it("shares one cap between the evals of a company and keeps other companies apart", async () => {
        const h = harness({ dailyCallCap: 1 });
        await createPublished(h);
        await createPublished(h, { slug: "second-eval" });
        await createPublished(h, {}, OTHER_COMPANY);
        expect((await run(h, AGENT, { title: "x" })).outcome).toBe("answered");
        expect((await run(h, AGENT, { title: "x" }, {}, "second-eval")).failureReason).toBe("cap_exceeded");
        const other = await h.service.run(AGENT_FOR_OTHER, OTHER_COMPANY, SLUG, runBody({ title: "x" }), { runId: null });
        expect(other.outcome).toBe("answered");
      });
    });

    describe("the cache", () => {
      it("serves the same input at the same version from the cache with zero tokens", async () => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => decision({ usage: { inputTokens: 120, outputTokens: 30 }, costUsd: 0.0012 });
        const first = await run(h, AGENT, { title: "same" });
        const second = await run(h, AGENT, { title: "same" });
        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.answers).toEqual(first.answers);
        expect(h.transportCalls).toHaveLength(1);
        expect(h.reservations.get(COMPANY)).toBe(1);
        expect(lastRun(h)).toMatchObject({ cached: true, inputTokens: 0, outputTokens: 0, costUsd: "0.000000", latencyMs: 0 });
      });

      it("does not reuse an answer for the same input at a new version", async () => {
        const h = harness();
        await createPublished(h);
        const first = await run(h, AGENT, { title: "same" });
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        await h.service.publish(BOARD, COMPANY, SLUG, { versionNumber: 2 });
        const second = await run(h, AGENT, { title: "same" });
        expect(second).toMatchObject({ cached: false, eval: { versionNumber: 2 } });
        expect(second.eval.versionId).not.toBe(first.eval.versionId);
        expect(h.transportCalls).toHaveLength(2);

        const again = await run(h, AGENT, { title: "same" });
        expect(again.cached).toBe(true);
        expect(h.transportCalls).toHaveLength(2);

        const [firstRow, secondRow] = h.repo.runs;
        expect(firstRow?.inputHash).toBe(secondRow?.inputHash);
        expect(firstRow?.versionId).not.toBe(secondRow?.versionId);
      });

      it("does not reuse an answer for a different input", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, { title: "one" });
        const other = await run(h, AGENT, { title: "two" });
        expect(other.cached).toBe(false);
        expect(h.transportCalls).toHaveLength(2);
      });

      it("shares no answer between companies", async () => {
        const h = harness();
        await createPublished(h);
        await createPublished(h, {}, OTHER_COMPANY);
        await run(h, AGENT, { title: "same" });
        const other = await h.service.run(AGENT_FOR_OTHER, OTHER_COMPANY, SLUG, runBody({ title: "same" }), { runId: null });
        expect(other.cached).toBe(false);
        expect(h.transportCalls).toHaveLength(2);
      });
    });

    describe("usage and cost", () => {
      it("records the tokens and cost from the judge outcome", async () => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => decision({ usage: { inputTokens: 120, outputTokens: 30 }, costUsd: 0.0012 });
        await run(h, AGENT, { title: "x" });
        expect(lastRun(h)).toMatchObject({ inputTokens: 120, outputTokens: 30, costUsd: "0.001200" });
      });

      it("records null for what the gateway did not report", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, { title: "no usage" });
        expect(lastRun(h)).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });

        h.gateway.respond = async () => decision({ usage: { inputTokens: 80 } });
        await run(h, AGENT, { title: "partial usage" });
        expect(lastRun(h)).toMatchObject({ inputTokens: 80, outputTokens: null, costUsd: null });
      });

      it("records a cost of zero as zero, not as unreported", async () => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => decision({ usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
        await run(h, AGENT, { title: "x" });
        expect(lastRun(h).costUsd).toBe("0.000000");
      });

      it("records an answered run with null tokens for a refusal, which has no usage data", async () => {
        const h = harness();
        await createPublished(h);
        h.gateway.respond = async () => {
          throw new DecisionRefusalError({
            questionIds: ["needs_qa", "qa_depth"],
            provider: "gateway",
            modelId: "typesafe-ai/jev-test",
          });
        };
        const result = await run(h, AGENT, { title: "x" });
        expect(result.outcome).toBe("answered");
        expect(answerOf(result.answers, "needs_qa")).toEqual({ type: "predicate", probability: null, value: null, abstained: true });
        expect(answerOf(result.answers, "qa_depth")).toMatchObject({ choice: null, abstained: true });
        expect(lastRun(h)).toMatchObject({
          outcome: "answered",
          anyAbstained: true,
          cached: false,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          modelId: "typesafe-ai/jev-test",
        });
        expect(h.reservations.get(COMPANY)).toBe(1);
      });
    });

    describe("the mode of a run", () => {
      it("is live for the published version, for an agent and for the board", async () => {
        const h = harness();
        await createPublished(h);
        expect((await run(h, AGENT, { title: "a" })).mode).toBe("live");
        expect((await run(h, BOARD, { title: "b" })).mode).toBe("live");
        expect(h.repo.runs.map((row) => row.mode)).toEqual(["live", "live"]);
      });

      it("is try_it for a board run of an eval that was never published, at its latest version", async () => {
        const h = harness();
        await createDraft(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        const result = await run(h, BOARD, { title: "x" });
        expect(result).toMatchObject({ mode: "try_it", eval: { versionNumber: 2 } });
        expect(lastRun(h).mode).toBe("try_it");
      });

      it("is try_it for a version that is not the published one and live for the published one", async () => {
        const h = harness();
        await createPublished(h);
        await h.service.createVersion(BOARD, COMPANY, SLUG, versionBody(reworded()));
        const draftVersion = await run(h, BOARD, { title: "x" }, { versionNumber: 2 });
        const publishedVersion = await run(h, BOARD, { title: "x" }, { versionNumber: 1 });
        const byDefault = await run(h, BOARD, { title: "x" });
        expect(draftVersion).toMatchObject({ mode: "try_it", eval: { versionNumber: 2 } });
        expect(publishedVersion).toMatchObject({ mode: "live", eval: { versionNumber: 1 } });
        expect(byDefault).toMatchObject({ mode: "live", eval: { versionNumber: 1 } });
      });

      it("is try_it when the board asks for it, even for the published version", async () => {
        const h = harness();
        await createPublished(h);
        const result = await run(h, BOARD, { title: "x" }, { mode: "try_it" });
        expect(result).toMatchObject({ mode: "try_it", eval: { versionNumber: 1 } });
        expect(lastRun(h).mode).toBe("try_it");
      });

      it("is try_it for an archived eval", async () => {
        const h = harness();
        await createPublished(h);
        await h.service.archive(BOARD, COMPANY, SLUG);
        const result = await run(h, BOARD, { title: "x" });
        expect(result).toMatchObject({ mode: "try_it", eval: { versionNumber: 1 } });
      });

      it("says not found for a version that does not exist", async () => {
        const h = harness();
        await createPublished(h);
        expect((await failure(run(h, BOARD, { title: "x" }, { versionNumber: 9 }))).code).toBe("not_found");
        expect(h.repo.runs).toHaveLength(0);
        expect(h.transportCalls).toHaveLength(0);
      });

      it("does not let an agent choose a version or a mode", async () => {
        const h = harness();
        await createPublished(h);
        for (const extra of [{ versionNumber: 1 }, { mode: "try_it" as const }]) {
          expect((await failure(run(h, AGENT, { title: "x" }, extra))).code).toBe("forbidden");
        }
        expect(h.repo.runs).toHaveLength(0);
        expect(h.transportCalls).toHaveLength(0);
      });
    });

    describe("the run id and issue a caller sends", () => {
      it("hands the header run id, the body issue and the actor to the check", async () => {
        const h = harness();
        await createPublished(h);
        h.runContext.next = { heartbeatRunId: HEARTBEAT_RUN_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, requestedIssueMissing: false };
        await h.service.run(AGENT, COMPANY, SLUG, runBody({ title: "x" }, { issueId: ISSUE_ID }), { runId: HEARTBEAT_RUN_ID });
        expect(h.runContext.calls).toEqual([{ companyId: COMPANY, actor: AGENT, runId: HEARTBEAT_RUN_ID, issueId: ISSUE_ID }]);
        expect(lastRun(h)).toMatchObject({ heartbeatRunId: HEARTBEAT_RUN_ID, issueId: ISSUE_ID, projectId: PROJECT_ID });
      });

      it("passes null when the caller sent neither", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, BOARD, { title: "x" });
        expect(h.runContext.calls).toEqual([{ companyId: COMPANY, actor: BOARD, runId: null, issueId: null }]);
      });

      it("stores no run, issue or project and still answers when the check verifies nothing", async () => {
        const h = harness();
        await createPublished(h);
        const result = await h.service.run(AGENT, COMPANY, SLUG, runBody({ title: "x" }), { runId: "not-a-uuid" });
        expect(result.outcome).toBe("answered");
        expect(lastRun(h)).toMatchObject({ heartbeatRunId: null, issueId: null, projectId: null });
      });

      it("says not found for an issue that is not in the company, and records nothing", async () => {
        const h = harness();
        await createPublished(h);
        h.runContext.next = { heartbeatRunId: null, issueId: null, projectId: null, requestedIssueMissing: true };
        const error = await failure(h.service.run(AGENT, COMPANY, SLUG, runBody({ title: "x" }, { issueId: ISSUE_ID }), { runId: null }));
        expect(error.code).toBe("not_found");
        expect(h.repo.runs).toHaveLength(0);
        expect(h.transportCalls).toHaveLength(0);
      });
    });

    describe("secrets in the input", () => {
      const input = { labels: ["ok", TOKEN], title: `deploy with ${TOKEN}` };
      const redacted = { labels: ["ok", MASK], title: `deploy with ${MASK}` };

      it("masks a token in a string field and in a string array item before anything leaves the service", async () => {
        const h = harness();
        await createPublished(h);
        const result = await run(h, AGENT, input);

        const request = JSON.stringify(h.transportCalls.map((call) => ({ state: call.state, questions: call.questions })));
        expect(h.transportCalls[0]?.state).toEqual(redacted);
        expect(request).not.toContain(TOKEN_CORE);

        const row = lastRun(h);
        expect(row.input).toEqual(redacted);
        expect(row).toMatchObject({
          inputRedacted: true,
          inputRedactionCount: 2,
          inputBytes: Buffer.byteLength(JSON.stringify(input)),
        });
        expect(JSON.stringify(row)).not.toContain(TOKEN_CORE);
        expect(JSON.stringify(result)).not.toContain(TOKEN_CORE);
      });

      it("hashes the redacted input", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, input);
        const row = lastRun(h);
        expect(row.inputHash).toBe(sha256(JSON.stringify(redacted)));
        expect(row.inputHash).not.toBe(sha256(JSON.stringify(input)));
      });

      it("counts a changed value once, however many secrets it holds", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, { title: `${TOKEN} and ${TOKEN}` });
        expect(lastRun(h)).toMatchObject({ inputRedacted: true, inputRedactionCount: 1 });
        expect(lastRun(h).input).toEqual({ title: `${MASK} and ${MASK}` });
      });

      it("does not check the redacted input against the schema again", async () => {
        const h = harness();
        await createPublished(h, {
          inputSchema: companyEvalInputSchemaSchema.parse({
            type: "object",
            properties: { title: { type: "string", maxLength: 20 } },
            required: ["title"],
          }),
        });
        const short = `${["pass", "word"].join("")}=abc12345`;
        expect(short.length).toBeLessThanOrEqual(20);
        const result = await run(h, AGENT, { title: short });
        expect(result.outcome).toBe("answered");
        const stored = lastRun(h).input;
        expect(stored).toEqual({ title: `${["pass", "word"].join("")}=${MASK}` });
        expect(JSON.stringify(stored).length).toBeGreaterThan(20);
      });

      it("reports no redaction for an input without secrets", async () => {
        const h = harness();
        await createPublished(h);
        await run(h, AGENT, { labels: ["bug", "ui"], title: "Fix the login page" });
        expect(lastRun(h)).toMatchObject({ inputRedacted: false, inputRedactionCount: 0 });
        expect(lastRun(h).input).toEqual({ labels: ["bug", "ui"], title: "Fix the login page" });
      });

      it("masks a secret in a rejected input of any shape and hashes the redacted input", async () => {
        const h = harness();
        await createPublished(h);
        const odd = { labels: [TOKEN], title: { deep: [{ more: TOKEN }, [TOKEN]] } };
        const error = await rejection(run(h, AGENT, odd));
        const row = lastRun(h);
        expect(row).toMatchObject({
          outcome: "rejected",
          failureReason: "input_invalid",
          inputRedacted: true,
          inputRedactionCount: 3,
          input: null,
          inputBytes: Buffer.byteLength(JSON.stringify(odd)),
          inputHash: sha256(JSON.stringify({ labels: [MASK], title: { deep: [{ more: MASK }, [MASK]] } })),
        });
        expect(JSON.stringify([row, error.rejection, error.message])).not.toContain(TOKEN_CORE);
        expect(h.transportCalls).toHaveLength(0);
      });

      it("masks a secret in an input that is too large", async () => {
        const h = harness();
        await createPublished(h, bodyOverrides("big-body"));
        const text = filler(33_000);
        const error = await rejection(run(h, AGENT, { body: `${TOKEN} ${text}` }, {}, "big-body"));
        const row = lastRun(h);
        expect(row).toMatchObject({
          failureReason: "input_too_large",
          inputRedacted: true,
          inputRedactionCount: 1,
          inputHash: sha256(JSON.stringify({ body: `${MASK} ${text}` })),
        });
        expect(JSON.stringify([row, error.rejection])).not.toContain(TOKEN_CORE);
      });

      it("keeps a secret out of a failed run too", async () => {
        const h = harness();
        await createPublished(h);
        h.keys.delete(COMPANY);
        await run(h, AGENT, input);
        const row = lastRun(h);
        expect(row.outcome).toBe("failed");
        expect(row.input).toEqual(redacted);
        expect(JSON.stringify(row)).not.toContain(TOKEN_CORE);
      });
    });
  });

  describe("input retention", () => {
    it("keeps the input until the retention days have passed", async () => {
      const h = harness({ retentionDays: 7 });
      await createPublished(h);
      await run(h, AGENT, { title: "x" });
      expect(lastRun(h)).toMatchObject({ input: { title: "x" }, inputExpiresAt: new Date("2026-10-16T12:00:00.000Z") });
    });

    it("stores no input and no expiry when the retention is 0, and keeps the hash and size", async () => {
      const h = harness({ retentionDays: 0 });
      await createPublished(h);
      const input = { title: "x" };
      await run(h, AGENT, input);
      keepsNoInput(lastRun(h), input);

      h.keys.delete(COMPANY);
      await run(h, AGENT, { title: "failed run" });
      keepsNoInput(lastRun(h), { title: "failed run" });
    });

    function keepsNoInput(row: RunRecord, input: unknown) {
      expect(row).toMatchObject({
        input: null,
        inputExpiresAt: null,
        inputHash: sha256(JSON.stringify(input)),
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
      });
    }

    function seedRun(h: Harness, overrides: Partial<NewRunRecord>): Promise<RunRecord> {
      return h.repo.insertRun({
        id: h.runtime.newId(),
        companyId: COMPANY,
        evalId: "eval-1",
        versionId: "version-1",
        versionNumber: 1,
        callerType: "user",
        callerAgentId: null,
        callerUserId: "board-user",
        heartbeatRunId: null,
        issueId: null,
        projectId: null,
        inputHash: "hash-of-the-input",
        inputRedacted: false,
        inputRedactionCount: 0,
        inputBytes: 17,
        input: { title: "kept until it expires" },
        inputExpiresAt: new Date(START),
        mode: "live",
        outcome: "answered",
        failureReason: null,
        answers: null,
        anyAbstained: false,
        cached: false,
        latencyMs: 5,
        modelId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: new Date(START),
        ...overrides,
      });
    }

    async function seedExpired(h: Harness, count: number) {
      for (let index = 0; index < count; index += 1) {
        await seedRun(h, { inputExpiresAt: new Date(Date.parse(START) - (index + 1) * DAY_MS) });
      }
    }

    it("clears expired inputs in batches, keeps the hash and size, and leaves live inputs alone", async () => {
      const h = harness();
      await seedExpired(h, 5);
      await seedRun(h, { inputExpiresAt: new Date(Date.parse(START) + DAY_MS), inputHash: "live-1" });
      await seedRun(h, { inputExpiresAt: null, input: null, inputHash: "no-input" });

      const cleared = await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime, batchSize: 2, maxBatches: 10 });
      expect(cleared).toBe(5);
      expect(h.repo.clearCalls).toEqual([2, 2, 2]);
      const expired = h.repo.runs.filter((row) => row.inputHash === "hash-of-the-input");
      expect(expired).toHaveLength(5);
      for (const row of expired) expect(row).toMatchObject({ input: null, inputBytes: 17, inputHash: "hash-of-the-input" });
      expect(h.repo.runs.find((row) => row.inputHash === "live-1")?.input).toEqual({ title: "kept until it expires" });
    });

    it("stops after the maximum number of batches and clears the rest on the next sweep", async () => {
      const h = harness();
      await seedExpired(h, 5);
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime, batchSize: 2, maxBatches: 2 })).toBe(4);
      expect(h.repo.clearCalls).toEqual([2, 2]);
      expect(h.repo.runs.filter((row) => row.input !== null)).toHaveLength(1);
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime, batchSize: 2, maxBatches: 2 })).toBe(1);
      expect(h.repo.runs.every((row) => row.input === null)).toBe(true);
    });

    it("asks for one more batch when the last one was full", async () => {
      const h = harness();
      await seedExpired(h, 4);
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime, batchSize: 2, maxBatches: 10 })).toBe(4);
      expect(h.repo.clearCalls).toEqual([2, 2, 2]);
    });

    it("clears nothing and stops after one batch when nothing has expired", async () => {
      const h = harness();
      await seedRun(h, { inputExpiresAt: new Date(Date.parse(START) + DAY_MS) });
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime })).toBe(0);
      expect(h.repo.clearCalls).toEqual([1_000]);
    });

    it("runs at most 20 batches of 1000 by default", async () => {
      const h = harness();
      const full = { ...h.repo, clearExpiredInputs: async (_now: Date, batchSize: number) => batchSize };
      const cleared = await sweepExpiredEvalInputs({ repo: full, runtime: h.runtime });
      expect(cleared).toBe(20_000);
    });

    it("clears an input at its expiry moment and not before", async () => {
      const h = harness();
      await seedRun(h, { inputExpiresAt: new Date(Date.parse(START) + 60 * 60 * 1000) });
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime })).toBe(0);
      h.clock.advanceWall(60 * 60 * 1000);
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime })).toBe(1);
    });

    it("removes the input of a real run after its retention and keeps what the stats need", async () => {
      const h = harness({ retentionDays: 1 });
      await createPublished(h);
      const input = { title: "x" };
      const result = await run(h, AGENT, input);
      h.clock.advanceWall(2 * DAY_MS);
      expect(await sweepExpiredEvalInputs({ repo: h.repo, runtime: h.runtime })).toBe(1);

      const detail = await h.service.getRun(BOARD, COMPANY, SLUG, result.runId);
      expect(detail).toMatchObject({
        input: null,
        inputHash: sha256(JSON.stringify(input)),
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        outcome: "answered",
      });
    });
  });

  describe("reading runs", () => {
    /** Five runs, one second apart: oldest first. */
    async function seedFiveRuns(h: Harness) {
      await createPublished(h);
      const ids: string[] = [];
      const record = (result: { runId: string }) => {
        ids.push(result.runId);
        h.clock.advanceWall(1_000);
      };
      record(await run(h, AGENT, { title: "agent one" }));
      record(await run(h, OTHER_AGENT, { title: "other agent" }));
      record(await run(h, BOARD, { title: "board try" }, { mode: "try_it" }));
      const rejected = await rejection(run(h, AGENT, { title: 5 }));
      record({ runId: rejected.rejection.runId });
      record(await run(h, AGENT, { title: "agent two" }));
      return ids;
    }

    it("shows the board every run, newest first", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const page = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 50 });
      expect(page.items.map((item) => item.id)).toEqual([...ids].reverse());
      expect(page.nextCursor).toBeNull();
      expect(page.items[0]?.input).toEqual({ title: "agent two" });
    });

    it("shows an agent only its own runs", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const page = await h.service.listRuns(AGENT, COMPANY, SLUG, { limit: 50 });
      expect(page.items.map((item) => item.id)).toEqual([ids[4], ids[3], ids[0]]);
      expect(page.items.every((item) => item.callerAgentId === AGENT_ID)).toBe(true);
    });

    it("ignores another agent id that an agent asks for", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const page = await h.service.listRuns(AGENT, COMPANY, SLUG, { limit: 50, agentId: OTHER_AGENT_ID });
      expect(page.items.map((item) => item.id)).toEqual([ids[4], ids[3], ids[0]]);
    });

    it("filters for the board by agent, outcome, mode and version", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const idsOf = async (query: Parameters<typeof h.service.listRuns>[3]) =>
        (await h.service.listRuns(BOARD, COMPANY, SLUG, query)).items.map((item) => item.id);
      expect(await idsOf({ limit: 50, agentId: OTHER_AGENT_ID })).toEqual([ids[1]]);
      expect(await idsOf({ limit: 50, outcome: "rejected" })).toEqual([ids[3]]);
      expect(await idsOf({ limit: 50, mode: "try_it" })).toEqual([ids[2]]);
      expect(await idsOf({ limit: 50, versionNumber: 1 })).toHaveLength(5);
      expect(await idsOf({ limit: 50, versionNumber: 2 })).toEqual([]);
    });

    it("filters by a time window that includes both ends", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const page = await h.service.listRuns(BOARD, COMPANY, SLUG, {
        limit: 50,
        from: "2026-10-09T12:00:02.000Z",
        to: "2026-10-09T12:00:03.000Z",
      });
      expect(page.items.map((item) => item.id)).toEqual([ids[3], ids[2]]);
    });

    it("pages with a cursor without repeating or skipping a run", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const newestFirst = [...ids].reverse();
      const first = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 2 });
      expect(first.nextCursor).not.toBeNull();
      const second = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 2, cursor: first.nextCursor ?? undefined });
      expect(second.nextCursor).not.toBeNull();
      const third = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 2, cursor: second.nextCursor ?? undefined });
      expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 2));
      expect(second.items.map((item) => item.id)).toEqual(newestFirst.slice(2, 4));
      expect(third.items.map((item) => item.id)).toEqual(newestFirst.slice(4));
      expect(third.nextCursor).toBeNull();
    });

    it("ends the last page with no cursor when the runs fill it exactly", async () => {
      const h = harness();
      await createPublished(h);
      for (const title of ["a", "b", "c", "d"]) {
        await run(h, BOARD, { title });
        h.clock.advanceWall(1_000);
      }
      const first = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 2 });
      const second = await h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 2, cursor: first.nextCursor ?? undefined });
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it("pages the runs of one agent with its own cursor", async () => {
      const h = harness();
      const ids = await seedFiveRuns(h);
      const first = await h.service.listRuns(AGENT, COMPANY, SLUG, { limit: 2 });
      const second = await h.service.listRuns(AGENT, COMPANY, SLUG, { limit: 2, cursor: first.nextCursor ?? undefined });
      expect(first.items.map((item) => item.id)).toEqual([ids[4], ids[3]]);
      expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
      expect(second.nextCursor).toBeNull();
    });

    it("rejects a run cursor that is not valid or has the wrong shape", async () => {
      const h = harness();
      await createPublished(h);
      for (const cursor of ["garbage", encodeCursor({ n: 3 }), encodeCursor({ slug: "x" })]) {
        expect((await failure(h.service.listRuns(BOARD, COMPANY, SLUG, { limit: 10, cursor }))).code).toBe("invalid_request");
      }
    });

    it("reads one run with its feedback, for the board and for the agent that made it", async () => {
      const h = harness();
      await createPublished(h);
      const result = await run(h, AGENT, { title: "x" });
      await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect", note: "wrong" });
      await h.service.putFeedback(AGENT, COMPANY, SLUG, result.runId, { verdict: "correct" });

      const asBoard = await h.service.getRun(BOARD, COMPANY, SLUG, result.runId);
      expect(asBoard.id).toBe(result.runId);
      expect(asBoard.feedback.map((mark) => [mark.authorType, mark.verdict])).toEqual([
        ["user", "incorrect"],
        ["agent", "correct"],
      ]);
      const asAgent = await h.service.getRun(AGENT, COMPANY, SLUG, result.runId);
      expect(asAgent.feedback).toHaveLength(2);
    });

    it("says not found for a run that is missing or that another agent made", async () => {
      const h = harness();
      await createPublished(h);
      const result = await run(h, AGENT, { title: "x" });
      expect((await failure(h.service.getRun(OTHER_AGENT, COMPANY, SLUG, result.runId))).code).toBe("not_found");
      expect((await failure(h.service.getRun(BOARD, COMPANY, SLUG, "11111111-1111-4111-8111-0000000000ff"))).code).toBe("not_found");
    });
  });

  describe("feedback", () => {
    async function answeredRun(h: Harness, actor: EvalActor = AGENT) {
      await createPublished(h);
      return run(h, actor, { title: "x" });
    }

    it("records a mark on the whole run", async () => {
      const h = harness();
      const result = await answeredRun(h);
      const mark = await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect", note: "wrong call" });
      expect(mark).toMatchObject({
        companyId: COMPANY,
        runId: result.runId,
        questionId: null,
        verdict: "incorrect",
        note: "wrong call",
        authorType: "user",
        authorUserId: "board-user",
        authorAgentId: null,
      });
      expect(h.repo.feedback[0]).toMatchObject({ questionKey: "", authorKey: "user:board-user" });
    });

    it("records a mark on one question", async () => {
      const h = harness();
      const result = await answeredRun(h);
      const mark = await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct", questionId: "needs_qa" });
      expect(mark.questionId).toBe("needs_qa");
      expect(h.repo.feedback[0]?.questionKey).toBe("needs_qa");
    });

    it("replaces the earlier mark of the same author on the same target", async () => {
      const h = harness();
      const result = await answeredRun(h);
      const first = await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect", note: "wrong call" });
      h.clock.advanceWall(5_000);
      const second = await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct" });
      expect(h.repo.feedback).toHaveLength(1);
      expect(second).toMatchObject({ id: first.id, verdict: "correct", note: null, createdAt: first.createdAt });
      expect(second.updatedAt).toBe("2026-10-09T12:00:05.000Z");
    });

    it("keeps apart the marks of different authors and different questions", async () => {
      const h = harness();
      const result = await answeredRun(h);
      await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct" });
      await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect", questionId: "needs_qa" });
      await h.service.putFeedback(OTHER_BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect" });
      await h.service.putFeedback(AGENT, COMPANY, SLUG, result.runId, { verdict: "correct" });
      expect(h.repo.feedback.map((row) => [row.authorKey, row.questionKey])).toEqual([
        ["user:board-user", ""],
        ["user:board-user", "needs_qa"],
        ["user:other-board-user", ""],
        [`agent:${AGENT_ID}`, ""],
      ]);
      expect(h.repo.feedback[3]).toMatchObject({ authorType: "agent", authorAgentId: AGENT_ID, authorUserId: null });
    });

    it("lets an agent mark its own run and not another agent's", async () => {
      const h = harness();
      const result = await answeredRun(h, AGENT);
      expect((await h.service.putFeedback(AGENT, COMPANY, SLUG, result.runId, { verdict: "correct" })).authorAgentId).toBe(AGENT_ID);
      const error = await failure(h.service.putFeedback(OTHER_AGENT, COMPANY, SLUG, result.runId, { verdict: "incorrect" }));
      expect(error.code).toBe("not_found");
      expect(h.repo.feedback).toHaveLength(1);
    });

    it("lets the board mark the run of any agent", async () => {
      const h = harness();
      const result = await answeredRun(h, AGENT);
      const mark = await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "incorrect" });
      expect(mark.authorType).toBe("user");
    });

    it("refuses a mark on a question that the run does not have", async () => {
      const h = harness();
      const result = await answeredRun(h);
      for (const questionId of ["nope", "constructor", "__proto__"]) {
        const error = await failure(h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct", questionId }));
        expect(error.code).toBe("invalid_request");
      }
      expect(h.repo.feedback).toHaveLength(0);
    });

    it("refuses a mark on a failed or a rejected run", async () => {
      const h = harness();
      await createPublished(h);
      h.keys.delete(COMPANY);
      const failed = await run(h, AGENT, { title: "x" });
      const rejected = await rejection(run(h, AGENT, { title: 5 }));
      for (const runId of [failed.runId, rejected.rejection.runId]) {
        const error = await failure(h.service.putFeedback(AGENT, COMPANY, SLUG, runId, { verdict: "correct" }));
        expect(error).toMatchObject({ code: "conflict", details: { code: "eval_run_not_answered" } });
      }
      expect(h.repo.feedback).toHaveLength(0);
    });

    it("says not found for a run that does not exist", async () => {
      const h = harness();
      await answeredRun(h);
      const error = await failure(
        h.service.putFeedback(BOARD, COMPANY, SLUG, "11111111-1111-4111-8111-0000000000ff", { verdict: "correct" }),
      );
      expect(error.code).toBe("not_found");
    });

    it("stops an agent from marking a run once the eval is no longer published", async () => {
      const h = harness();
      const result = await answeredRun(h);
      await h.service.archive(BOARD, COMPANY, SLUG);
      expect((await failure(h.service.putFeedback(AGENT, COMPANY, SLUG, result.runId, { verdict: "correct" }))).code).toBe("not_found");
      expect((await h.service.putFeedback(BOARD, COMPANY, SLUG, result.runId, { verdict: "correct" })).verdict).toBe("correct");
    });
  });
});

const AGENT_FOR_OTHER: EvalActor = { type: "agent", agentId: AGENT_ID };

/** Text of exactly `length` characters that no secret detector takes for a secret. */
function filler(length: number): string {
  return "lorem ipsum dolor ".repeat(Math.ceil(length / 18)).slice(0, length);
}
