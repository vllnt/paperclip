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

interface ReportOptions extends CompanyOptions {
  groupBy?: string;
  since?: string;
  until?: string;
  agentId?: string;
  routineId?: string;
  projectId?: string;
  issueId?: string;
  adapterType?: string;
  provider?: string;
  model?: string;
  limit?: string;
  status?: string;
  cause?: string;
}

interface ReportBody {
  groupBy: string;
  since: string;
  until: string;
  rows: unknown[];
  totals: unknown;
  truncated: boolean;
}

const QUERY_FLAGS = [
  ["groupBy", "groupBy"],
  ["since", "since"],
  ["until", "until"],
  ["agentId", "agentId"],
  ["routineId", "routineId"],
  ["projectId", "projectId"],
  ["issueId", "issueId"],
  ["adapterType", "adapterType"],
  ["provider", "provider"],
  ["model", "model"],
  ["status", "status"],
  ["cause", "cause"],
  ["limit", "limit"],
] as const satisfies ReadonlyArray<readonly [keyof ReportOptions, string]>;

function queryString(opts: ReportOptions): string {
  const params = new URLSearchParams();
  for (const [option, name] of QUERY_FLAGS) {
    const value = opts[option];
    if (typeof value === "string" && value.trim() !== "") params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function isReportBody(value: unknown): value is ReportBody {
  return typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows) && "totals" in value;
}

function printReport(kind: string, body: unknown, json: boolean | undefined): void {
  if (json || !isReportBody(body)) {
    printOutput(body, { json });
    return;
  }
  printOutput(body.rows, { label: `${kind} by ${body.groupBy}, ${body.since} to ${body.until}` });
  printOutput(body.totals, { label: "totals" });
  if (body.truncated) {
    console.log("There are more groups than the limit. Raise --limit or add a filter.");
  }
}

function addReportOptions(command: Command): Command {
  return command
    .option("-C, --company-id <id>", "Company ID")
    .option("--group-by <dimension>", "Dimension to group by")
    .option("--since <date>", "Start of the window, inclusive (ISO date or time; default: 7 days before --until)")
    .option("--until <date>", "End of the window, exclusive (ISO date or time; default: now)")
    .option("--agent-id <id>", "Only runs of this agent")
    .option("--routine-id <id>", "Only runs of this routine")
    .option("--project-id <id>", "Only runs of this project")
    .option("--issue-id <id>", "Only runs of this issue")
    .option("--adapter-type <type>", "Only runs of this adapter type")
    .option("--provider <name>", "Only runs that used this provider")
    .option("--model <name>", "Only runs that used this model")
    .option("--limit <n>", "Most groups to return (default 50, most 500; day and hour groups are not cut)");
}

export function registerObservabilityCommands(program: Command): void {
  const observability = program
    .command("observability")
    .description("Usage, cost and failure data for runs, and the health of its collector");

  addCommonClientOptions(
    observability
      .command("health")
      .description("Show whether run usage records are being derived (derived share, pending, late)")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/observability/health`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    addReportOptions(
      observability
        .command("usage")
        .description(
          "Tokens, cost and duration of runs, grouped by agent, routine, project, issue, adapter, provider, model, status, day or hour",
        )
        .option("--status <status>", "Only runs that ended with this status"),
    ).action(async (opts: ReportOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const result = await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/observability/usage`}${queryString(opts)}`);
        printReport("Usage", result, ctx.json);
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    addReportOptions(
      observability
        .command("failures")
        .description(
          "Failed runs grouped by cause (default), agent, routine, project, issue, adapter, provider, model, day or hour",
        )
        .option("--cause <cause>", "Only runs that failed for this cause"),
    ).action(async (opts: ReportOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const result = await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/observability/failures`}${queryString(opts)}`);
        printReport("Failures", result, ctx.json);
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}
