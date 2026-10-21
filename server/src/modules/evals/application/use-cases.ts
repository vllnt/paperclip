import {
  COMPANY_EVAL_LIMITS,
  type CompanyEval,
  type CompanyEvalAgentView,
  type CompanyEvalDetail,
  type CompanyEvalFeedback,
  type CompanyEvalPage,
  type CompanyEvalRun,
  type CompanyEvalRunDetail,
  type CompanyEvalRunResult,
  type CompanyEvalVersion,
  type CreateCompanyEval,
  type CreateCompanyEvalVersion,
  type ListCompanyEvalRunsQuery,
  type ListCompanyEvalVersionsQuery,
  type ListCompanyEvalsQuery,
  type PublishCompanyEval,
  type PutCompanyEvalFeedback,
  type RunCompanyEval,
  type UpdateCompanyEval,
} from "@paperclipai/shared";
import { canonicalJson, utf8ByteLength } from "../domain/canonical.js";
import { decodeCursor, encodeCursor } from "../domain/cursor.js";
import { isInputTooDeep, isJsonObject, redactJsonStrings } from "../domain/input.js";
import { compileInputValidator, type InputValidator } from "../domain/input-validator.js";
import {
  anyAnswerAbstained,
  feedbackAuthorKey,
  inputExpiry,
  isVisibleToAgents,
  resolveRunMode,
  toRunAnswers,
} from "../domain/policy.js";
import { toEval, toFeedback, toRun, toVersion } from "./mappers.js";
import type {
  EvalJudgePort,
  EvalsRepository,
  EvalsRuntime,
  EvalsSettings,
  RunContextPort,
} from "./ports.js";
import {
  EvalInputRejectedError,
  EvalSlugTakenError,
  EvalsApplicationError,
  type EvalActor,
  type EvalRecord,
  type NewRunRecord,
  type NewVersionFields,
  type RejectionFacts,
  type RunCursor,
  type RunFilter,
  type VersionRecord,
} from "./types.js";

const NO_KEY_HINT = "Add the company secret AI_GATEWAY_API_KEY";
const VALIDATOR_CACHE_MAX = 500;
const VERSION_APPEND_ATTEMPTS = 3;
/** The marker hashed in place of an input that is too deeply nested to walk. */
const TOO_DEEP_HASH_TEXT = "company-eval-input:too-deep";
/**
 * Redaction and hashing run on inputs up to this size (32 times the input cap). A larger input is
 * rejected at once, so one request cannot make the server scan megabytes of text. Its hash is of a
 * marker and the size, never of the raw text.
 */
const MAX_SCANNED_INPUT_BYTES = 32 * COMPANY_EVAL_LIMITS.maxInputBytes;
const TOO_LARGE_HASH_TEXT = "company-eval-input:too-large";

export interface EvalsServiceDeps {
  repo: EvalsRepository;
  judge: EvalJudgePort;
  runContext: RunContextPort;
  runtime: EvalsRuntime;
  settings: EvalsSettings;
}

export interface RunCallerContext {
  /** The run id from the signed token or the `X-Paperclip-Run-Id` header. Not trusted. */
  runId: string | null;
}

function notFound(what: string): EvalsApplicationError {
  return new EvalsApplicationError("not_found", `${what} not found`);
}

function requireBoard(actor: EvalActor): Extract<EvalActor, { type: "user" }> {
  if (actor.type !== "user") {
    throw new EvalsApplicationError("forbidden", "Only board users can change evals.");
  }
  return actor;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlugCursor(value: unknown): value is { slug: string } {
  return isPlainRecord(value) && typeof value.slug === "string";
}

function isVersionCursor(value: unknown): value is { n: number } {
  return isPlainRecord(value) && typeof value.n === "number" && Number.isInteger(value.n);
}

const CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// A cursor is untrusted input. Its time and id go to the database as typed values, so a position
// that is not a time and a UUID must be refused here, as a 400, and not fail later as a 500.
function isRunCursor(value: unknown): value is RunCursor {
  return (
    isPlainRecord(value) &&
    typeof value.at === "string" &&
    CURSOR_TIME_PATTERN.test(value.at) &&
    Number.isFinite(Date.parse(value.at)) &&
    typeof value.id === "string" &&
    CURSOR_UUID_PATTERN.test(value.id)
  );
}

function readCursor<T extends Record<string, string | number>>(
  cursor: string | undefined,
  guard: (value: unknown) => value is T,
): T | null {
  if (cursor === undefined) return null;
  const position = decodeCursor(cursor, guard);
  if (!position) throw new EvalsApplicationError("invalid_request", "The cursor is not valid.");
  return position;
}

function parseDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

export type EvalsService = ReturnType<typeof createEvalsService>;

/**
 * The company evals use cases. Authoring (create, edit, version, publish, archive, delete) is for
 * board users. Agents list and read published evals, run them, read their own runs and mark them.
 * Every query is scoped to the company and a missing row and another company's row read the same.
 */
export function createEvalsService(deps: EvalsServiceDeps) {
  const { repo, judge, runContext, runtime, settings } = deps;
  const validators = new Map<string, InputValidator>();

  function validatorFor(version: VersionRecord): InputValidator {
    const known = validators.get(version.id);
    if (known) return known;
    // Versions never change, so a compiled validator is valid for as long as the process runs.
    if (validators.size >= VALIDATOR_CACHE_MAX) validators.clear();
    const created = compileInputValidator(version.inputSchema, runtime.redactText);
    validators.set(version.id, created);
    return created;
  }

  function definitionHash(definition: Pick<CreateCompanyEvalVersion, "inputSchema" | "questions">): string {
    return runtime.sha256Hex(canonicalJson({ inputSchema: definition.inputSchema, questions: definition.questions }));
  }

  function newVersionFields(body: CreateCompanyEvalVersion, userId: string | null, now: Date): NewVersionFields {
    return {
      id: runtime.newId(),
      inputSchema: body.inputSchema,
      questions: body.questions,
      definitionHash: definitionHash(body),
      changeNote: body.changeNote ?? null,
      createdByUserId: userId,
      createdAt: now,
    };
  }

  async function requireEval(actor: EvalActor, companyId: string, slug: string): Promise<EvalRecord> {
    const record = await repo.findEvalBySlug(companyId, slug);
    if (!record) throw notFound("Eval");
    if (actor.type === "agent" && !isVisibleToAgents(record)) throw notFound("Eval");
    return record;
  }

  async function publishedVersionNumber(companyId: string, record: EvalRecord): Promise<number | null> {
    if (!record.publishedVersionId) return null;
    const [version] = await repo.getVersionsByIds(companyId, [record.publishedVersionId]);
    return version?.versionNumber ?? null;
  }

  async function detailFor(companyId: string, record: EvalRecord): Promise<CompanyEvalDetail> {
    const ids = record.publishedVersionId ? [record.publishedVersionId] : [];
    const [versions, latest] = await Promise.all([
      repo.getVersionsByIds(companyId, ids),
      record.latestVersionNumber > 0
        ? repo.getVersionByNumber(companyId, record.id, record.latestVersionNumber)
        : Promise.resolve(null),
    ]);
    const published = versions[0] ?? null;
    return {
      ...toEval(record, published?.versionNumber ?? null),
      publishedVersion: published ? toVersion(published) : null,
      latestVersion: latest ? toVersion(latest) : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------------------------

  async function list(
    actor: EvalActor,
    companyId: string,
    query: Pick<ListCompanyEvalsQuery, "status" | "limit" | "cursor">,
  ): Promise<CompanyEvalPage<CompanyEval> | CompanyEvalPage<CompanyEvalAgentView>> {
    const after = readCursor(query.cursor, isSlugCursor);
    const isAgent = actor.type === "agent";
    const rows = await repo.listEvals(companyId, {
      statuses: isAgent ? ["published"] : query.status ? [query.status] : ["draft", "published"],
      publishedOnly: isAgent,
      limit: query.limit + 1,
      afterSlug: after?.slug,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > query.limit && last ? encodeCursor({ slug: last.slug }) : null;
    const versionIds = page.flatMap((row) => (row.publishedVersionId ? [row.publishedVersionId] : []));
    const versions = new Map((await repo.getVersionsByIds(companyId, versionIds)).map((version) => [version.id, version]));
    if (!isAgent) {
      return {
        items: page.map((row) => toEval(row, versions.get(row.publishedVersionId ?? "")?.versionNumber ?? null)),
        nextCursor,
      };
    }
    const items: CompanyEvalAgentView[] = [];
    for (const row of page) {
      const version = versions.get(row.publishedVersionId ?? "");
      if (!version) continue;
      items.push(agentView(row, version));
    }
    return { items, nextCursor };
  }

  function agentView(record: EvalRecord, version: VersionRecord): CompanyEvalAgentView {
    return {
      id: record.id,
      slug: record.slug,
      title: record.title,
      whenToUse: record.whenToUse,
      publishedVersion: { id: version.id, versionNumber: version.versionNumber, inputSchema: version.inputSchema },
    };
  }

  async function get(actor: EvalActor, companyId: string, slug: string): Promise<CompanyEvalDetail | CompanyEvalAgentView> {
    const record = await requireEval(actor, companyId, slug);
    if (actor.type === "user") return detailFor(companyId, record);
    const [version] = await repo.getVersionsByIds(companyId, record.publishedVersionId ? [record.publishedVersionId] : []);
    if (!version) throw notFound("Eval");
    return agentView(record, version);
  }

  async function create(actor: EvalActor, companyId: string, body: CreateCompanyEval): Promise<CompanyEvalDetail> {
    const board = requireBoard(actor);
    if (await repo.findEvalBySlug(companyId, body.slug)) {
      throw new EvalsApplicationError("conflict", `An eval with the slug "${body.slug}" already exists.`, {
        code: "eval_slug_taken",
      });
    }
    const now = runtime.now();
    try {
      const created = await repo.insertEvalWithFirstVersion(
        {
          id: runtime.newId(),
          companyId,
          slug: body.slug,
          title: body.title,
          whenToUse: body.whenToUse,
          createdByUserId: board.userId,
          now,
        },
        newVersionFields(body, board.userId, now),
      );
      return {
        ...toEval(created.eval, null),
        publishedVersion: null,
        latestVersion: toVersion(created.version),
      };
    } catch (error) {
      if (error instanceof EvalSlugTakenError) {
        throw new EvalsApplicationError("conflict", error.message, { code: "eval_slug_taken" });
      }
      throw error;
    }
  }

  async function update(actor: EvalActor, companyId: string, slug: string, body: UpdateCompanyEval): Promise<CompanyEval> {
    const board = requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const updated = await repo.updateEvalMeta(companyId, record.id, {
      title: body.title,
      whenToUse: body.whenToUse,
      updatedByUserId: board.userId,
      now: runtime.now(),
    });
    if (!updated) throw notFound("Eval");
    return toEval(updated, await publishedVersionNumber(companyId, updated));
  }

  /**
   * Saves a definition as the next version. A definition equal to the latest version's creates
   * nothing and returns that version. Numbering uses a compare-and-set on the eval row, so two
   * writers cannot take the same number.
   */
  async function createVersion(
    actor: EvalActor,
    companyId: string,
    slug: string,
    body: CreateCompanyEvalVersion,
  ): Promise<{ version: CompanyEvalVersion; created: boolean }> {
    const board = requireBoard(actor);
    const hash = definitionHash(body);
    for (let attempt = 0; attempt < VERSION_APPEND_ATTEMPTS; attempt += 1) {
      const record = await requireEval(actor, companyId, slug);
      const latest = await repo.getVersionByNumber(companyId, record.id, record.latestVersionNumber);
      if (latest && latest.definitionHash === hash) return { version: toVersion(latest), created: false };
      const appended = await repo.appendVersion({
        companyId,
        evalId: record.id,
        expectedLatest: record.latestVersionNumber,
        version: newVersionFields(body, board.userId, runtime.now()),
      });
      if (appended) return { version: toVersion(appended), created: true };
    }
    throw new EvalsApplicationError("conflict", "The eval changed while saving. Try again.", {
      code: "eval_version_conflict",
    });
  }

  async function listVersions(
    actor: EvalActor,
    companyId: string,
    slug: string,
    query: Pick<ListCompanyEvalVersionsQuery, "limit" | "cursor">,
  ): Promise<CompanyEvalPage<CompanyEvalVersion>> {
    requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const before = readCursor(query.cursor, isVersionCursor);
    const rows = await repo.listVersions(companyId, record.id, { limit: query.limit + 1, beforeNumber: before?.n });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toVersion),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ n: last.versionNumber }) : null,
    };
  }

  async function getVersion(actor: EvalActor, companyId: string, slug: string, versionNumber: number): Promise<CompanyEvalVersion> {
    requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const version = await repo.getVersionByNumber(companyId, record.id, versionNumber);
    if (!version) throw notFound("Version");
    return toVersion(version);
  }

  async function publish(actor: EvalActor, companyId: string, slug: string, body: PublishCompanyEval): Promise<CompanyEval> {
    const board = requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const version = await repo.getVersionByNumber(companyId, record.id, body.versionNumber ?? record.latestVersionNumber);
    if (!version) throw notFound("Version");
    const updated = await repo.setPublished(companyId, record.id, {
      versionId: version.id,
      updatedByUserId: board.userId,
      now: runtime.now(),
    });
    if (!updated) throw notFound("Eval");
    return toEval(updated, version.versionNumber);
  }

  async function archive(actor: EvalActor, companyId: string, slug: string): Promise<CompanyEval> {
    const board = requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const updated = await repo.setArchived(companyId, record.id, { updatedByUserId: board.userId, now: runtime.now() });
    if (!updated) throw notFound("Eval");
    return toEval(updated, await publishedVersionNumber(companyId, updated));
  }

  /** Deletes an eval that was never published. Anything else is archived instead. */
  async function remove(actor: EvalActor, companyId: string, slug: string): Promise<{ id: string; slug: string }> {
    requireBoard(actor);
    const record = await requireEval(actor, companyId, slug);
    const historyError = new EvalsApplicationError(
      "conflict",
      "This eval was published, so it keeps its history. Archive it instead.",
      { code: "eval_has_history" },
    );
    if (record.publishedAt !== null) throw historyError;
    if (!(await repo.deleteNeverPublished(companyId, record.id))) throw historyError;
    return { id: record.id, slug: record.slug };
  }

  // -------------------------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------------------------

  async function resolveVersion(actor: EvalActor, record: EvalRecord, body: RunCompanyEval): Promise<VersionRecord> {
    const companyId = record.companyId;
    if (actor.type === "agent") {
      if (body.versionNumber !== undefined || body.mode !== undefined) {
        throw new EvalsApplicationError("forbidden", "Agents run the published version. They cannot pick a version or a mode.");
      }
      const [published] = await repo.getVersionsByIds(companyId, record.publishedVersionId ? [record.publishedVersionId] : []);
      if (!published) throw notFound("Eval");
      return published;
    }
    if (body.versionNumber !== undefined) {
      const picked = await repo.getVersionByNumber(companyId, record.id, body.versionNumber);
      if (!picked) throw notFound("Version");
      return picked;
    }
    const wanted = record.publishedVersionId
      ? (await repo.getVersionsByIds(companyId, [record.publishedVersionId]))[0]
      : await repo.getVersionByNumber(companyId, record.id, record.latestVersionNumber);
    if (!wanted) throw notFound("Version");
    return wanted;
  }

  /**
   * Runs one version of an eval with one input and records the call.
   *
   * Order: actor rules, run id and issue check, size, schema, secret redaction, one Jev call, one
   * run row. A rejected input and a Jev failure are both recorded and neither is a guessed answer.
   * A rejected input throws `input_rejected` with the id of its recorded run.
   */
  async function run(
    actor: EvalActor,
    companyId: string,
    slug: string,
    body: RunCompanyEval,
    caller: RunCallerContext,
  ): Promise<CompanyEvalRunResult> {
    const record = await requireEval(actor, companyId, slug);
    const version = await resolveVersion(actor, record, body);
    const context = await runContext.verify({
      companyId,
      actor,
      runId: caller.runId,
      issueId: body.issueId ?? null,
    });
    if (context.requestedIssueMissing) throw notFound("Issue");

    const now = runtime.now();
    const mode = resolveRunMode({
      evalStatus: record.status,
      publishedVersionId: record.publishedVersionId,
      runVersionId: version.id,
      requestedMode: body.mode,
    });
    const base = {
      companyId,
      evalId: record.id,
      versionId: version.id,
      versionNumber: version.versionNumber,
      callerType: actor.type === "agent" ? ("agent" as const) : ("user" as const),
      callerAgentId: actor.type === "agent" ? actor.agentId : null,
      callerUserId: actor.type === "user" ? actor.userId : null,
      heartbeatRunId: context.heartbeatRunId,
      issueId: context.issueId,
      projectId: context.projectId,
      mode,
      createdAt: now,
    };

    const rejectedRow = (input: {
      reason: "input_too_large" | "input_invalid";
      inputHash: string;
      inputBytes: number;
      redactionCount: number;
    }): NewRunRecord => ({
      ...base,
      id: runtime.newId(),
      inputHash: input.inputHash,
      inputRedacted: input.redactionCount > 0,
      inputRedactionCount: input.redactionCount,
      inputBytes: input.inputBytes,
      input: null,
      inputExpiresAt: null,
      outcome: "rejected",
      failureReason: input.reason,
      answers: null,
      anyAbstained: false,
      cached: false,
      latencyMs: 0,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });

    const reject = async (row: NewRunRecord, details: RejectionFacts): Promise<never> => {
      const saved = await repo.insertRun(row);
      throw new EvalInputRejectedError(
        details.code === "eval_input_too_large" ? "The input is too large." : "The input does not match the eval's input schema.",
        { ...details, runId: saved.id },
      );
    };

    const rawInput = body.input;
    if (isInputTooDeep(rawInput)) {
      return reject(
        rejectedRow({
          reason: "input_invalid",
          inputHash: runtime.sha256Hex(TOO_DEEP_HASH_TEXT),
          inputBytes: 0,
          redactionCount: 0,
        }),
        { code: "eval_input_invalid", errors: [{ path: "/", message: "is nested too deeply" }] },
      );
    }

    const inputBytes = utf8ByteLength(JSON.stringify(rawInput) ?? "null");
    if (inputBytes > MAX_SCANNED_INPUT_BYTES) {
      return reject(
        rejectedRow({
          reason: "input_too_large",
          inputHash: runtime.sha256Hex(`${TOO_LARGE_HASH_TEXT}:${inputBytes}`),
          inputBytes,
          redactionCount: 0,
        }),
        { code: "eval_input_too_large", maxInputBytes: COMPANY_EVAL_LIMITS.maxInputBytes, inputBytes },
      );
    }
    // Redaction runs before the hash, so no row holds a hash of raw secret text, even a rejected one.
    const redacted = redactJsonStrings(rawInput, runtime.redactText);
    const inputHash = runtime.sha256Hex(canonicalJson(redacted.value));

    if (inputBytes > COMPANY_EVAL_LIMITS.maxInputBytes) {
      return reject(
        rejectedRow({ reason: "input_too_large", inputHash, inputBytes, redactionCount: redacted.redactionCount }),
        { code: "eval_input_too_large", maxInputBytes: COMPANY_EVAL_LIMITS.maxInputBytes, inputBytes },
      );
    }

    // The schema check reads the raw input: a mask can be longer than a short `maxLength`.
    const issues = validatorFor(version)(rawInput);
    if (issues.length > 0) {
      return reject(
        rejectedRow({ reason: "input_invalid", inputHash, inputBytes, redactionCount: redacted.redactionCount }),
        { code: "eval_input_invalid", errors: issues },
      );
    }
    if (!isJsonObject(redacted.value)) {
      throw new EvalsApplicationError("invalid_request", "The input must be a JSON object.");
    }

    const startedAt = runtime.monotonicMs();
    const outcome = await judge.ask({
      companyId,
      rubricVersion: version.id,
      state: redacted.value,
      questions: version.questions,
    });
    const latencyMs = Math.max(0, Math.round(runtime.monotonicMs() - startedAt));

    const expiresAt = inputExpiry(now, settings.inputRetentionDays);
    const stored = {
      ...base,
      id: runtime.newId(),
      inputHash,
      inputRedacted: redacted.redactionCount > 0,
      inputRedactionCount: redacted.redactionCount,
      inputBytes,
      input: expiresAt ? redacted.value : null,
      inputExpiresAt: expiresAt,
      latencyMs,
    };

    const row: NewRunRecord = outcome.ok
      ? {
          ...stored,
          outcome: "answered",
          failureReason: null,
          answers: toRunAnswers(outcome.answers),
          anyAbstained: anyAnswerAbstained(outcome.answers),
          cached: outcome.cached,
          modelId: outcome.modelId,
          // A cache hit used no tokens. A refusal has no usage data, so it records none.
          inputTokens: outcome.cached ? 0 : (outcome.usage?.inputTokens ?? null),
          outputTokens: outcome.cached ? 0 : (outcome.usage?.outputTokens ?? null),
          costUsd: outcome.cached ? "0.000000" : outcome.costUsd !== undefined ? outcome.costUsd.toFixed(6) : null,
        }
      : {
          ...stored,
          outcome: "failed",
          failureReason: outcome.reason,
          answers: null,
          anyAbstained: false,
          cached: false,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        };
    const saved = await repo.insertRun(row);

    return {
      runId: saved.id,
      eval: { id: record.id, slug: record.slug, versionId: version.id, versionNumber: version.versionNumber },
      outcome: outcome.ok ? "answered" : "failed",
      failureReason: outcome.ok ? null : outcome.reason,
      answers: saved.answers,
      cached: saved.cached,
      latencyMs: saved.latencyMs,
      modelId: saved.modelId,
      mode: saved.mode,
      ...(!outcome.ok && outcome.reason === "no_key" ? { hint: NO_KEY_HINT } : {}),
    };
  }

  async function listRuns(
    actor: EvalActor,
    companyId: string,
    slug: string,
    query: ListCompanyEvalRunsQuery,
  ): Promise<CompanyEvalPage<CompanyEvalRun>> {
    const record = await requireEval(actor, companyId, slug);
    const after = readCursor(query.cursor, isRunCursor);
    const filter: RunFilter = {
      from: parseDate(query.from),
      to: parseDate(query.to),
      versionNumber: query.versionNumber,
      // An agent reads only its own runs, whatever agent id it asks for.
      agentId: actor.type === "agent" ? actor.agentId : query.agentId,
      projectId: query.projectId,
      outcome: query.outcome,
      mode: query.mode,
    };
    const rows = await repo.listRuns(companyId, record.id, { filter, limit: query.limit + 1, after });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRun),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async function requireRun(actor: EvalActor, companyId: string, record: EvalRecord, runId: string) {
    const found = await repo.getRun(companyId, record.id, runId);
    if (!found) throw notFound("Run");
    if (actor.type === "agent" && found.callerAgentId !== actor.agentId) throw notFound("Run");
    return found;
  }

  async function getRun(actor: EvalActor, companyId: string, slug: string, runId: string): Promise<CompanyEvalRunDetail> {
    const record = await requireEval(actor, companyId, slug);
    const found = await requireRun(actor, companyId, record, runId);
    const feedback = await repo.listFeedback(companyId, found.id);
    return { ...toRun(found), feedback: feedback.map(toFeedback) };
  }

  /**
   * Records a correct or incorrect mark on an answered run, or on one of its questions. A later
   * mark by the same author on the same target replaces the earlier one. An agent can mark only
   * its own runs.
   */
  async function putFeedback(
    actor: EvalActor,
    companyId: string,
    slug: string,
    runId: string,
    body: PutCompanyEvalFeedback,
  ): Promise<CompanyEvalFeedback> {
    const record = await requireEval(actor, companyId, slug);
    const found = await requireRun(actor, companyId, record, runId);
    if (found.outcome !== "answered") {
      throw new EvalsApplicationError("conflict", "Only an answered run can get feedback.", { code: "eval_run_not_answered" });
    }
    if (body.questionId !== undefined && !Object.hasOwn(found.answers ?? {}, body.questionId)) {
      throw new EvalsApplicationError("invalid_request", `The run has no question "${body.questionId}".`);
    }
    const author = actor.type === "agent" ? { type: "agent" as const, agentId: actor.agentId } : { type: "user" as const, userId: actor.userId };
    const saved = await repo.upsertFeedback({
      id: runtime.newId(),
      companyId,
      runId: found.id,
      questionKey: body.questionId ?? "",
      verdict: body.verdict,
      note: body.note ?? null,
      authorType: author.type,
      authorKey: feedbackAuthorKey(author),
      authorAgentId: actor.type === "agent" ? actor.agentId : null,
      authorUserId: actor.type === "user" ? actor.userId : null,
      now: runtime.now(),
    });
    return toFeedback(saved);
  }

  return {
    list,
    get,
    create,
    update,
    createVersion,
    listVersions,
    getVersion,
    publish,
    archive,
    remove,
    run,
    listRuns,
    getRun,
    putFeedback,
  };
}

/**
 * Clears stored inputs whose retention has passed, in batches. The hash and the size stay.
 * @returns How many inputs it cleared.
 */
export async function sweepExpiredEvalInputs(deps: {
  repo: Pick<EvalsRepository, "clearExpiredInputs">;
  runtime: Pick<EvalsRuntime, "now">;
  batchSize?: number;
  maxBatches?: number;
}): Promise<number> {
  const batchSize = deps.batchSize ?? 1_000;
  const maxBatches = deps.maxBatches ?? 20;
  let cleared = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const count = await deps.repo.clearExpiredInputs(deps.runtime.now(), batchSize);
    cleared += count;
    if (count < batchSize) break;
  }
  return cleared;
}
