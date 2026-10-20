import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { RoutineStepWarning } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
  projectId?: string;
}

interface JsonOptions extends CompanyOptions {
  payloadJson?: string;
  limit?: string;
}

interface RoutineWriteOptions extends JsonOptions {
  stepsFile?: string;
}

interface RoutineRunOptions extends JsonOptions {
  targetIssue?: string;
}

/** The loose 8-4-4-4-12 hex shape the server accepts for `targetIssueId`. */
const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RoutineListOptions extends CompanyOptions {
  q?: string;
  agentId?: string;
  folderId?: string;
  status?: string;
  trigger?: string;
}

/** Builds the list query from the CLI flags; the server validates the values. */
function routineListQuery(opts: RoutineListOptions): string {
  const params = new URLSearchParams();
  const entries: Array<[string, string | undefined]> = [
    ["projectId", opts.projectId],
    ["q", opts.q],
    ["assigneeAgentId", opts.agentId],
    ["folderId", opts.folderId],
    ["status", opts.status],
    ["trigger", opts.trigger],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function registerRoutineApiCommands(program: Command): void {
  const routine = program.command("routine").description("Routine API operations");
  addCommonClientOptions(
    routine
      .command("list")
      .description("List routines; filters combine with AND")
      .option("-C, --company-id <id>", "Company ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--q <text>", "Search the title and description (case-insensitive)")
      .option("--agent-id <id>", "Only routines assigned to this agent")
      .option("--folder-id <id>", "Only routines in this folder; none for routines in no folder")
      .option("--status <status>", "active, paused or archived")
      .option("--trigger <kind>", "schedule, webhook, api, event, or manual for routines with no trigger")
      .action(async (opts: RoutineListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = routineListQuery(opts);
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/routines`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
  addRoutineCreate(routine);
  addIdGet(routine, "get", "Get a routine", "routines");
  addRoutineUpdate(routine);
  addIdGet(routine, "revisions", "List routine revisions", "routines", "revisions");
  addCommonClientOptions(
    routine
      .command("revision:restore")
      .description("Restore a routine revision")
      .argument("<routineId>", "Routine ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (routineId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routines/${routineId}/revisions/${revisionId}/restore`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    routine
      .command("runs")
      .description("List routine runs")
      .argument("<routineId>", "Routine ID")
      .option("--limit <n>", "Maximum runs to return")
      .action(async (routineId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.limit ? `?${new URLSearchParams({ limit: opts.limit }).toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/routines/${routineId}/runs`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addRoutineRun(routine);
  addIdPost(
    routine,
    "trigger:create",
    "Create a routine trigger (an event trigger can set eventGrouping.issueMode to event_issue to start the steps on the created task)",
    "routines",
    "triggers",
  );
  addIdPatch(routine, "trigger:update", "Update a routine trigger", "routine-triggers");
  addIdDelete(routine, "trigger:delete", "Delete a routine trigger", "routine-triggers");
  addIdPost(routine, "trigger:rotate-secret", "Rotate a routine trigger secret", "routine-triggers", "rotate-secret");
  addCommonClientOptions(
    routine
      .command("trigger:fire")
      .description("Fire a public routine trigger")
      .argument("<publicId>", "Public trigger ID")
      .option("--payload-json <json>", "Public trigger payload", "{}")
      .action(async (publicId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routine-triggers/public/${publicId}/fire`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

const STEPS_FILE_DESCRIPTION = "Read the routine steps (a JSON array) from a file; replaces steps in the payload";

/** Reads the JSON in a steps file; a parse error names the file, because the parser's message does not. */
async function readStepsFile(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return parseJson(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${reason}`);
  }
}

/**
 * Builds the create or update payload. `--steps-file` supplies `steps` from a file so a long
 * step list does not have to be quoted inside `--payload-json`; the server validates the steps.
 */
async function routineWritePayload(opts: RoutineWriteOptions): Promise<unknown> {
  const payload = parseJson(opts.payloadJson ?? "{}");
  if (!opts.stepsFile) return payload;
  if (!isJsonObject(payload)) throw new Error("--payload-json must be a JSON object when --steps-file is used.");
  if ("steps" in payload) throw new Error("Pass steps either in --payload-json or with --steps-file, not both.");
  const steps = await readStepsFile(opts.stepsFile);
  if (!Array.isArray(steps)) throw new Error(`${opts.stepsFile} must contain a JSON array of steps.`);
  return { ...payload, steps };
}

function isStepWarning(value: unknown): value is RoutineStepWarning {
  return (
    isJsonObject(value) &&
    value.code === "step_agent_unavailable" &&
    typeof value.stepKey === "string" &&
    typeof value.agentId === "string" &&
    typeof value.reason === "string"
  );
}

/**
 * Writes the step warnings of a routine save or run to stderr, one line each, so stdout stays the
 * response. The save or run already succeeded; a warning says a step may not start.
 */
function printStepWarnings(response: unknown): void {
  if (!isJsonObject(response) || !Array.isArray(response.warnings)) return;
  for (const warning of response.warnings) {
    if (isStepWarning(warning)) {
      console.error(`warning: step "${warning.stepKey}": agent ${warning.agentId} is ${warning.reason}`);
    }
  }
}

/** Prints a routine write or run response, with its step warnings on stderr. */
function printRoutineResult(response: unknown, json: boolean | undefined): void {
  printStepWarnings(response);
  printOutput(response, { json });
}

function addRoutineRun(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("run")
      .description("Run a routine; --target-issue starts its steps on an existing task instead of creating one")
      .argument("<id>", "Routine ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .option("--target-issue <issue>", "Start the routine's steps on this task (UUID or identifier such as PC-12)")
      .action(async (id: string, opts: RoutineRunOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          let body = parseJson(opts.payloadJson ?? "{}");
          if (opts.targetIssue) {
            if (!isJsonObject(body)) throw new Error("--payload-json must be a JSON object when --target-issue is used.");
            if ("targetIssueId" in body) {
              throw new Error("Pass the task either as targetIssueId in --payload-json or with --target-issue, not both.");
            }
            const targetIssueId = await resolveIssueId(opts.targetIssue, (issue) =>
              ctx.api.get<unknown>(apiPath`/api/issues/${issue}`),
            );
            body = { ...body, targetIssueId };
          }
          printRoutineResult(await ctx.api.post(apiPath`/api/routines/${id}/run`, body), ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

/** A UUID passes through; an identifier such as PC-12 is looked up with the issue GET, which accepts both. */
async function resolveIssueId(reference: string, fetchIssue: (reference: string) => Promise<unknown>): Promise<string> {
  const trimmed = reference.trim();
  if (ISSUE_ID_PATTERN.test(trimmed)) return trimmed;
  const issue = await fetchIssue(trimmed);
  if (isJsonObject(issue) && typeof issue.id === "string") return issue.id;
  throw new Error(`Could not find the task "${trimmed}".`);
}

function addRoutineCreate(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("create")
      .description("Create a routine (payload may set steps)")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .option("--steps-file <path>", STEPS_FILE_DESCRIPTION)
      .action(async (opts: RoutineWriteOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printRoutineResult(await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/routines`, await routineWritePayload(opts)), ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addRoutineUpdate(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("update")
      .description("Update a routine (payload may set runContextPolicy and steps; steps [] clears them)")
      .argument("<id>", "ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .option("--steps-file <path>", STEPS_FILE_DESCRIPTION)
      .action(async (id: string, opts: RoutineWriteOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printRoutineResult(await ctx.api.patch(apiPath`/api/routines/${id}`, await routineWritePayload(opts)), ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addIdGet(parent: Command, name: string, description: string, resource: string, suffix?: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/${resource}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPatch(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").requiredOption("--payload-json <json>", "JSON payload").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.patch(`/api/${resource}/${encodeURIComponent(id)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPost(parent: Command, name: string, description: string, resource: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").option("--payload-json <json>", "JSON payload", "{}").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/${resource}/${encodeURIComponent(id)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdDelete(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.delete(`/api/${resource}/${encodeURIComponent(id)}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
