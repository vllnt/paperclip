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
}

interface ListOptions extends CompanyOptions {
  includeArchived?: boolean;
}

interface CreateOptions extends CompanyOptions {
  name?: string;
  signingMode?: string;
  normalizer?: string;
  normalizerConfigJson?: string;
  replayWindowSec?: string;
  rateLimitPerMinute?: string;
  maxNewIssuesPerHour?: string;
  retentionDays?: string;
  payloadJson?: string;
}

interface TestOptions extends BaseClientOptions {
  file?: string;
  payloadJson?: string;
}

interface DeliveriesOptions extends BaseClientOptions {
  status?: string;
  limit?: string;
  cursor?: string;
}

export function registerEventSourceApiCommands(program: Command): void {
  const eventSources = program.command("event-sources").description("Event source operations (external signed events that wake routines)");

  addCommonClientOptions(
    eventSources
      .command("list")
      .description("List event sources")
      .option("-C, --company-id <id>", "Company ID")
      .option("--include-archived", "Include archived sources")
      .action(async (opts: ListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = opts.includeArchived ? "?includeArchived=true" : "";
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/event-sources`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    eventSources
      .command("create")
      .description("Create an event source; the response shows the ingress URL and signing secret once")
      .option("-C, --company-id <id>", "Company ID")
      .option("--name <name>", "Source name")
      .option("--signing-mode <mode>", "hmac_sha256 (default) or bearer")
      .option("--normalizer <normalizer>", "generic_v1 (default) or gatus")
      .option("--normalizer-config-json <json>", "Normalizer config (gatus endpointMap, severity defaults)")
      .option("--replay-window-sec <n>", "HMAC replay window in seconds")
      .option("--rate-limit-per-minute <n>", "Per-source rate limit")
      .option("--max-new-issues-per-hour <n>", "Storm breaker: new alert issues per hour")
      .option("--retention-days <n>", "Delivery audit retention")
      .option("--payload-json <json>", "Full JSON body; overrides the individual flags")
      .action(async (opts: CreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/event-sources`, buildCreateBody(opts)), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    eventSources
      .command("rotate")
      .description("Rotate an event source secret; the previous secret stops working immediately")
      .argument("<sourceId>", "Event source ID")
      .action(async (sourceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/event-sources/${sourceId}/rotate-secret`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    eventSources
      .command("test")
      .description("Dry-run a payload against a source: shows each stage and writes nothing")
      .argument("<sourceId>", "Event source ID")
      .option("--file <path>", "JSON file with the event payload")
      .option("--payload-json <json>", "Inline JSON event payload")
      .action(async (sourceId: string, opts: TestOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = await readPayload(opts);
          printOutput(await ctx.api.post(apiPath`/api/event-sources/${sourceId}/test`, { payload }), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    eventSources
      .command("deliveries")
      .description("List recent deliveries for an event source")
      .argument("<sourceId>", "Event source ID")
      .option("--status <status>", "Filter by delivery status")
      .option("--limit <n>", "Maximum deliveries to return")
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .action(async (sourceId: string, opts: DeliveriesOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.cursor) params.set("cursor", opts.cursor);
          const query = params.size > 0 ? `?${params.toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/event-sources/${sourceId}/deliveries`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function buildCreateBody(opts: CreateOptions): Record<string, unknown> {
  if (opts.payloadJson) return parseJsonObject(opts.payloadJson, "--payload-json");
  if (!opts.name) throw new Error("Pass --name (or a full --payload-json body).");
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.signingMode) body.signingMode = opts.signingMode;
  if (opts.normalizer) body.normalizer = opts.normalizer;
  if (opts.normalizerConfigJson) body.normalizerConfig = parseJsonObject(opts.normalizerConfigJson, "--normalizer-config-json");
  assignInteger(body, "replayWindowSec", opts.replayWindowSec, "--replay-window-sec");
  assignInteger(body, "rateLimitPerMinute", opts.rateLimitPerMinute, "--rate-limit-per-minute");
  assignInteger(body, "maxNewIssuesPerHour", opts.maxNewIssuesPerHour, "--max-new-issues-per-hour");
  assignInteger(body, "retentionDays", opts.retentionDays, "--retention-days");
  return body;
}

async function readPayload(opts: TestOptions): Promise<unknown> {
  if (opts.file && opts.payloadJson) throw new Error("Pass either --file or --payload-json, not both.");
  if (opts.file) return parseJson(await readFile(opts.file, "utf8"), "--file");
  if (opts.payloadJson) return parseJson(opts.payloadJson, "--payload-json");
  throw new Error("Pass the event with --file <path> or --payload-json <json>.");
}

function assignInteger(body: Record<string, unknown>, key: string, value: string | undefined, flag: string): void {
  if (value === undefined) return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer.`);
  body[key] = parsed;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}
