import { readFile } from "node:fs/promises";
import { Command } from "commander";
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
  addIdPost(routine, "run", "Run a routine", "routines", "run");
  addIdPost(routine, "trigger:create", "Create a routine trigger", "routines", "triggers");
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
  } catch {
    // The parser's message quotes part of the file, which may hold secrets: name only the file.
    throw new Error(`${file} is not valid JSON.`);
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
          printOutput(await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/routines`, await routineWritePayload(opts)), { json: ctx.json });
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
          printOutput(await ctx.api.patch(apiPath`/api/routines/${id}`, await routineWritePayload(opts)), { json: ctx.json });
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
