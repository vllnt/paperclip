import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import {
  COMPANY_EVAL_RUN_MODES,
  COMPANY_EVAL_RUN_OUTCOMES,
  COMPANY_EVAL_STATUSES,
  type CompanyEval,
  type CompanyEvalAgentView,
  type CompanyEvalAnswer,
  type CompanyEvalDetail,
  type CompanyEvalFeedback,
  type CompanyEvalInputSchema,
  type CompanyEvalPage,
  type CompanyEvalQuestions,
  type CompanyEvalRun,
  type CompanyEvalRunResult,
  type CompanyEvalStatus,
  type CompanyEvalVersion,
} from "@paperclipai/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

// Company evals are Jev decisions a company defines once and runs many times. They are not the
// runner's developer evals (`doc/evals.md`).

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface PageOptions extends CompanyOptions {
  limit?: number;
  cursor?: string;
}

interface ListOptions extends PageOptions {
  status?: CompanyEvalStatus;
}

interface CreateOptions extends CompanyOptions {
  slug: string;
  title: string;
  whenToUse: string;
  definition: string;
  note?: string;
}

interface EditOptions extends CompanyOptions {
  title?: string;
  whenToUse?: string;
  definition?: string;
  note?: string;
}

interface PublishOptions extends CompanyOptions {
  version?: number;
}

interface RunOptions extends CompanyOptions {
  input?: string;
  inputJson?: string;
  issueId?: string;
  version?: number;
  tryIt?: boolean;
}

interface RunsOptions extends PageOptions {
  from?: string;
  to?: string;
  version?: number;
  agentId?: string;
  projectId?: string;
  outcome?: string;
  mode?: string;
}

interface FeedbackOptions extends CompanyOptions {
  correct?: boolean;
  incorrect?: boolean;
  question?: string;
  note?: string;
}

/** The parts of a definition file. The server validates their content. */
interface DefinitionFile {
  inputSchema: Record<string, unknown>;
  questions: Record<string, unknown>;
}

interface EditResult {
  eval?: CompanyEval | null;
  version?: CompanyEvalVersion | null;
  /** True for a new version, false when the definition matched the latest one, null when unknown. */
  versionCreated?: boolean | null;
}

type EvalListItem = CompanyEval | CompanyEvalAgentView;
type EvalShowItem = CompanyEvalDetail | CompanyEvalAgentView;

export function registerEvalsCommands(program: Command): void {
  const evals = program
    .command("evals")
    .description("Company evals: Jev decisions a company defines once and runs many times");

  addCommonClientOptions(
    evals
      .command("list")
      .description("List evals")
      .addOption(new Option("--status <status>", "Filter by status").choices(COMPANY_EVAL_STATUSES))
      .option("--limit <n>", "Maximum items to return", parsePositiveInteger)
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .action(async (opts: ListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = buildQuery({ status: opts.status, limit: opts.limit, cursor: opts.cursor });
          const page = await ctx.api.get<CompanyEvalPage<EvalListItem>>(`${evalsPath(ctx)}${query}`);
          printPage(page, ctx, formatListItem);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("show")
      .description("Show one eval with its published and latest versions")
      .argument("<slug>", "Eval slug")
      .action(async (slug: string, opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const detail = await ctx.api.get<EvalShowItem>(evalPath(ctx, slug));
          if (ctx.json || !detail) {
            printOutput(detail, { json: ctx.json });
            return;
          }
          printDetail(detail);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("create")
      .description("Create an eval as a draft with its first version")
      .requiredOption("--slug <slug>", "Eval slug: 2-63 lowercase letters, digits and hyphens")
      .requiredOption("--title <title>", "Short title")
      .requiredOption("--when-to-use <text>", "When a caller should run this eval")
      .requiredOption("--definition <file.json>", 'JSON file with { "inputSchema": {...}, "questions": {...} }')
      .option("--note <text>", "Change note for the first version")
      .action(async (opts: CreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const definition = await readDefinitionFile(opts.definition);
          const body: Record<string, unknown> = {
            slug: opts.slug,
            title: opts.title,
            whenToUse: opts.whenToUse,
            inputSchema: definition.inputSchema,
            questions: definition.questions,
          };
          if (opts.note !== undefined) body.changeNote = opts.note;
          const created = await ctx.api.post<CompanyEval>(evalsPath(ctx), body);
          if (ctx.json || !created) {
            printOutput(created, { json: ctx.json });
            return;
          }
          console.log(`Created eval ${pc.bold(created.slug)} (${created.status}, version ${created.latestVersionNumber}).`);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("edit")
      .description("Change the title or when-to-use text, or add a version from a definition file")
      .argument("<slug>", "Eval slug")
      .option("--title <title>", "New title")
      .option("--when-to-use <text>", "New when-to-use text")
      .option("--definition <file.json>", 'JSON file with { "inputSchema": {...}, "questions": {...} }; adds a version')
      .option("--note <text>", "Change note for the new version (needs --definition)")
      .action(async (slug: string, opts: EditOptions) => {
        try {
          const hasMetadata = opts.title !== undefined || opts.whenToUse !== undefined;
          if (!hasMetadata && opts.definition === undefined) {
            throw new Error("Nothing to change. Pass --title, --when-to-use or --definition.");
          }
          if (opts.note !== undefined && opts.definition === undefined) {
            throw new Error("--note needs --definition.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          // Read the file before the first request, so a bad file changes nothing on the server.
          const definition = opts.definition === undefined ? undefined : await readDefinitionFile(opts.definition);
          const path = evalPath(ctx, slug);
          const result: EditResult = {};

          if (hasMetadata) {
            const body: Record<string, unknown> = {};
            if (opts.title !== undefined) body.title = opts.title;
            if (opts.whenToUse !== undefined) body.whenToUse = opts.whenToUse;
            result.eval = await ctx.api.patch<CompanyEval>(path, body);
          }

          if (definition) {
            // The API client does not expose the HTTP status, so tell a new version (201) from an
            // identical definition (200, the existing latest version) by the version number.
            const latestBefore =
              typeof result.eval?.latestVersionNumber === "number"
                ? result.eval.latestVersionNumber
                : (await ctx.api.get<CompanyEval>(path))?.latestVersionNumber;
            const body: Record<string, unknown> = {
              inputSchema: definition.inputSchema,
              questions: definition.questions,
            };
            if (opts.note !== undefined) body.changeNote = opts.note;
            const version = await ctx.api.post<CompanyEvalVersion>(`${path}/versions`, body);
            result.version = version;
            result.versionCreated =
              version === null || typeof latestBefore !== "number" ? null : version.versionNumber > latestBefore;
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          if (result.eval !== undefined) console.log(`Updated eval ${pc.bold(slug)}.`);
          if (result.version !== undefined) printEditedVersion(slug, result);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("versions")
      .description("List the versions of an eval, newest first")
      .argument("<slug>", "Eval slug")
      .option("--limit <n>", "Maximum items to return", parsePositiveInteger)
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .action(async (slug: string, opts: PageOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = buildQuery({ limit: opts.limit, cursor: opts.cursor });
          const page = await ctx.api.get<CompanyEvalPage<CompanyEvalVersion>>(`${evalPath(ctx, slug)}/versions${query}`);
          printPage(page, ctx, formatVersionLine);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("publish")
      .description("Publish a version of an eval; agents can run only the published version")
      .argument("<slug>", "Eval slug")
      .option("--version <n>", "Version number to publish (default: the latest)", parsePositiveInteger)
      .action(async (slug: string, opts: PublishOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const body: Record<string, unknown> = {};
          if (opts.version !== undefined) body.versionNumber = opts.version;
          const published = await ctx.api.post<CompanyEval>(`${evalPath(ctx, slug)}/publish`, body);
          if (ctx.json || !published) {
            printOutput(published, { json: ctx.json });
            return;
          }
          const version = published.publishedVersionNumber === null ? "" : ` at version ${published.publishedVersionNumber}`;
          console.log(`Published eval ${pc.bold(published.slug)}${version}.`);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("archive")
      .description("Archive an eval; agents can no longer run it")
      .argument("<slug>", "Eval slug")
      .action(async (slug: string, opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const archived = await ctx.api.post<CompanyEval>(`${evalPath(ctx, slug)}/archive`, {});
          if (ctx.json || !archived) {
            printOutput(archived, { json: ctx.json });
            return;
          }
          console.log(`Archived eval ${pc.bold(archived.slug)}.`);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("run")
      .description("Run an eval on an input and print the answers")
      .argument("<slug>", "Eval slug")
      .option("--input <file>", "JSON file with the input; use - to read stdin")
      .option("--input-json <json>", "Inline JSON input")
      .option("--issue-id <id>", "Issue ID to link the run to")
      .option("--version <n>", "Version number to run (board only)", parsePositiveInteger)
      .option("--try-it", "Record the run as a try-it run that stats do not count (board only)")
      .action(async (slug: string, opts: RunOptions) => {
        try {
          if ((opts.input === undefined) === (opts.inputJson === undefined)) {
            throw new Error("Pass exactly one of --input <file or -> or --input-json <json>.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const input =
            opts.input !== undefined
              ? await readJsonSource(opts.input, "--input")
              : parseJson(opts.inputJson ?? "", "--input-json");
          const body: Record<string, unknown> = { input };
          if (opts.issueId !== undefined) body.issueId = opts.issueId;
          if (opts.version !== undefined) body.versionNumber = opts.version;
          if (opts.tryIt) body.mode = "try_it";
          const result = await ctx.api.post<CompanyEvalRunResult>(`${evalPath(ctx, slug)}/runs`, body);
          if (ctx.json || !result) {
            printOutput(result, { json: ctx.json });
            return;
          }
          printRunResult(result);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("runs")
      .description("List the runs of an eval, newest first")
      .argument("<slug>", "Eval slug")
      .option("--from <iso8601>", "Only runs at or after this time (ISO 8601 with offset or Z)")
      .option("--to <iso8601>", "Only runs at or before this time (ISO 8601 with offset or Z)")
      .option("--version <n>", "Only runs of this version number", parsePositiveInteger)
      .option("--agent-id <id>", "Only runs by this agent")
      .option("--project-id <id>", "Only runs linked to this project")
      .addOption(new Option("--outcome <outcome>", "Only runs with this outcome").choices(COMPANY_EVAL_RUN_OUTCOMES))
      .addOption(new Option("--mode <mode>", "Only runs in this mode").choices(COMPANY_EVAL_RUN_MODES))
      .option("--limit <n>", "Maximum items to return", parsePositiveInteger)
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .action(async (slug: string, opts: RunsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = buildQuery({
            from: opts.from,
            to: opts.to,
            versionNumber: opts.version,
            agentId: opts.agentId,
            projectId: opts.projectId,
            outcome: opts.outcome,
            mode: opts.mode,
            limit: opts.limit,
            cursor: opts.cursor,
          });
          const page = await ctx.api.get<CompanyEvalPage<CompanyEvalRun>>(`${evalPath(ctx, slug)}/runs${query}`);
          printPage(page, ctx, formatRunLine);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    evals
      .command("feedback")
      .description("Mark a run, or one of its answers, as correct or incorrect")
      .argument("<slug>", "Eval slug")
      .argument("<runId>", "Eval run ID (from `evals run` or `evals runs`)")
      .option("--correct", "The answer was right")
      .option("--incorrect", "The answer was wrong")
      .option("--question <id>", "Question ID the verdict is about (default: the whole run)")
      .option("--note <text>", "Short note that explains the verdict")
      .action(async (slug: string, runId: string, opts: FeedbackOptions) => {
        try {
          if (Boolean(opts.correct) === Boolean(opts.incorrect)) {
            throw new Error("Pass exactly one of --correct or --incorrect.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const verdict = opts.correct ? "correct" : "incorrect";
          const body: Record<string, unknown> = { verdict };
          if (opts.question !== undefined) body.questionId = opts.question;
          if (opts.note !== undefined) body.note = opts.note;
          const feedback = await ctx.api.put<CompanyEvalFeedback>(
            apiPath`/api/companies/${ctx.companyId}/evals/${slug}/runs/${runId}/feedback`,
            body,
          );
          if (ctx.json || !feedback) {
            printOutput(feedback, { json: ctx.json });
            return;
          }
          const scope = feedback.questionId === null ? "" : ` for question ${feedback.questionId}`;
          console.log(`Recorded ${feedback.verdict} feedback on run ${runId}${scope}.`);
        } catch (err) {
          handleEvalsError(err);
        }
      }),
    { includeCompany: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Paths, queries and errors
// ---------------------------------------------------------------------------------------------

function evalsPath(ctx: ResolvedClientContext): string {
  return apiPath`/api/companies/${ctx.companyId}/evals`;
}

function evalPath(ctx: ResolvedClientContext, slug: string): string {
  return apiPath`/api/companies/${ctx.companyId}/evals/${slug}`;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value.trim())) {
    throw new InvalidArgumentError("Must be a positive whole number.");
  }
  return Number(value);
}

/**
 * Prints an API error. A rejected run answers 422 with `code` and `runId` in the body; the shared
 * error line leaves them out, so this keeps them. The body holds JSON pointers, never input values.
 */
function handleEvalsError(error: unknown): never {
  if (error instanceof ApiRequestError && isRecord(error.body)) {
    const code = typeof error.body.code === "string" ? error.body.code : undefined;
    const runId = typeof error.body.runId === "string" ? error.body.runId : undefined;
    if (code !== undefined || runId !== undefined) {
      const parts = [`API error ${error.status}: ${error.message}`];
      if (code !== undefined) parts.push(`code=${code}`);
      if (runId !== undefined) parts.push(`runId=${runId}`);
      if (error.details !== undefined) parts.push(`details=${JSON.stringify(error.details)}`);
      console.error(pc.red(parts.join(" ")));
      process.exit(1);
    }
  }
  return handleCommandError(error);
}

// ---------------------------------------------------------------------------------------------
// Files, stdin and JSON
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextFile(filePath: string, flag: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    const reason = code === "ENOENT" ? "file not found" : code === "EISDIR" ? "path is a directory" : (code ?? "read failed");
    throw new Error(`Cannot read ${flag} file ${filePath}: ${reason}.`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses JSON. The error never repeats the text: it can hold an eval input. */
function parseJson(text: string, label: string): unknown {
  if (text.trim() === "") throw new Error(`${label} is empty. Pass a JSON value.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function readJsonSource(source: string, flag: string): Promise<unknown> {
  if (source === "-") return parseJson(await readStdin(), `${flag} (stdin)`);
  return parseJson(await readTextFile(source, flag), `${flag} file ${source}`);
}

async function readDefinitionFile(filePath: string): Promise<DefinitionFile> {
  const label = `--definition file ${filePath}`;
  const parsed = parseJson(await readTextFile(filePath, "--definition"), label);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must hold a JSON object with "inputSchema" and "questions".`);
  }
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "inputSchema" && key !== "questions");
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknownKeys.join(", ")}. Allowed keys: inputSchema, questions.`);
  }
  const { inputSchema, questions } = parsed;
  if (!isRecord(inputSchema)) throw new Error(`${label} needs "inputSchema" as a JSON object.`);
  if (!isRecord(questions)) throw new Error(`${label} needs "questions" as a JSON object.`);
  return { inputSchema, questions };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function printPage<T>(
  page: CompanyEvalPage<T> | null,
  ctx: ResolvedClientContext,
  formatItem: (item: T) => string,
): void {
  if (ctx.json || !page) {
    printOutput(page, { json: ctx.json });
    return;
  }
  if (page.items.length === 0) {
    console.log(pc.dim("(empty)"));
  }
  for (const item of page.items) console.log(formatItem(item));
  if (page.nextCursor) {
    console.log(pc.dim(`More results: add --cursor ${page.nextCursor}`));
  }
}

function statusLabel(status: CompanyEvalStatus): string {
  if (status === "published") return pc.green(status);
  if (status === "archived") return pc.dim(status);
  return pc.yellow(status);
}

function formatListItem(item: EvalListItem): string {
  if ("status" in item) {
    const published = item.publishedVersionNumber === null ? "-" : `v${item.publishedVersionNumber}`;
    return `${pc.bold(item.slug)}  ${statusLabel(item.status)}  published ${published}  latest v${item.latestVersionNumber}  ${item.title}`;
  }
  return `${pc.bold(item.slug)}  published v${item.publishedVersion.versionNumber}  ${item.title}`;
}

function formatVersionLine(version: CompanyEvalVersion): string {
  const note = version.changeNote ?? "-";
  return `v${version.versionNumber}  ${version.createdAt}  ${version.definitionHash.slice(0, 8)}  ${note}`;
}

function formatRunLine(run: CompanyEvalRun): string {
  const caller =
    run.callerType === "agent" ? `agent:${run.callerAgentId ?? "-"}` : `user:${run.callerUserId ?? "-"}`;
  const outcome = run.failureReason === null ? run.outcome : `${run.outcome} (${run.failureReason})`;
  return `${run.id}  ${run.createdAt}  v${run.versionNumber}  ${run.mode}  ${outcome}  ${run.latencyMs} ms  ${caller}`;
}

function describeInputSchema(schema: CompanyEvalInputSchema): string {
  const required = new Set(schema.required);
  return Object.entries(schema.properties)
    .map(([name, property]) => `${name}${required.has(name) ? "*" : ""} (${property.type})`)
    .join(", ");
}

function describeQuestions(questions: CompanyEvalQuestions): string {
  return Object.entries(questions)
    .map(([id, question]) => `${id} (${question.type})`)
    .join(", ");
}

function printDetail(detail: EvalShowItem): void {
  if (!("status" in detail)) {
    console.log(`${pc.bold(detail.slug)}  published v${detail.publishedVersion.versionNumber}`);
    console.log(`Title: ${detail.title}`);
    console.log(`When to use: ${detail.whenToUse}`);
    console.log(`Input (* is required): ${describeInputSchema(detail.publishedVersion.inputSchema)}`);
    return;
  }
  const published = detail.publishedVersionNumber === null ? "-" : `v${detail.publishedVersionNumber}`;
  console.log(`${pc.bold(detail.slug)}  ${statusLabel(detail.status)}  published ${published}  latest v${detail.latestVersionNumber}`);
  console.log(`Title: ${detail.title}`);
  console.log(`When to use: ${detail.whenToUse}`);
  const latest = detail.latestVersion;
  if (latest) {
    console.log(`Input of v${latest.versionNumber} (* is required): ${describeInputSchema(latest.inputSchema)}`);
    console.log(`Questions of v${latest.versionNumber}: ${describeQuestions(latest.questions)}`);
  }
  console.log(pc.dim("Use --json for the full definition."));
}

function printEditedVersion(slug: string, result: EditResult): void {
  const version = result.version;
  if (!version) {
    console.log(`Sent the definition for eval ${pc.bold(slug)}.`);
    return;
  }
  if (result.versionCreated === false) {
    console.log(`No new version: the definition matches the latest version (v${version.versionNumber}).`);
    return;
  }
  console.log(`Created version ${version.versionNumber} of eval ${pc.bold(slug)}.`);
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatAnswer(answer: CompanyEvalAnswer): string {
  switch (answer.type) {
    case "predicate": {
      const verdict = answer.abstained ? "abstained" : answer.value === null ? "-" : String(answer.value);
      return answer.probability === null ? verdict : `${verdict} (p=${formatNumber(answer.probability)})`;
    }
    case "choice": {
      const verdict = answer.abstained ? "abstained" : (answer.choice ?? "-");
      return answer.confidence === null ? verdict : `${verdict} (confidence ${formatNumber(answer.confidence)})`;
    }
    case "score": {
      const verdict = answer.abstained ? "abstained" : answer.score === null ? "-" : String(answer.score);
      return answer.confidence === null ? verdict : `${verdict} (confidence ${formatNumber(answer.confidence)})`;
    }
  }
}

/** A failed run is a recorded result, not a CLI error: print the reason and the hint, exit 0. */
function printRunResult(result: CompanyEvalRunResult): void {
  const details = [`mode ${result.mode}`, result.cached ? "cached" : "fresh", `${result.latencyMs} ms`];
  if (result.modelId) details.push(`model ${result.modelId}`);
  console.log(`Run ${result.runId}  ${pc.bold(result.eval.slug)} v${result.eval.versionNumber}  ${details.join(", ")}`);

  if (result.outcome === "failed") {
    console.log(pc.yellow(`Outcome: failed (${result.failureReason ?? "unknown reason"})`));
    if (result.hint) console.log(`Hint: ${result.hint}`);
    return;
  }

  console.log(pc.green("Outcome: answered"));
  for (const [questionId, answer] of Object.entries(result.answers ?? {})) {
    console.log(`  ${questionId}: ${formatAnswer(answer)}`);
  }
}
