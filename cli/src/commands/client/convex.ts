import { Command } from "commander";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/** The bundled Convex plugin. These commands call its board actions; guards and grants live in the plugin. */
const PLUGIN = "vllnt.paperclip-convex";

interface ConvexOptions extends BaseClientOptions {
  companyId?: string;
}
interface ListOptions extends ConvexOptions {
  project?: string;
  type?: string;
}
interface DryRunOptions extends ConvexOptions {
  dryRun?: boolean;
}

interface DeploymentRow {
  name: string;
  environment: string;
  deploymentType: string | null;
  previewIdentifier: string | null;
  lastDeployTime: number | null;
  expiresAt: number | null;
}
interface ReaperProject {
  name: string;
  previews: number;
  delete: Array<{ name: string; reason: string }>;
  deleted: string[];
  setExpiry: unknown[];
  expirySet: string[];
  kept: number;
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}
interface ReaperReport {
  at: string;
  dryRun: boolean;
  projects: ReaperProject[];
  quota: { count: number; quota: number; percent: number; alert: boolean; partial: boolean } | null;
  errors: string[];
}

async function callAction<T>(opts: ConvexOptions, key: string, params: Record<string, unknown> = {}): Promise<{ data: T; json: boolean }> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const response = await ctx.api.post<{ data: T }>(`/api/plugins/${encodeURIComponent(PLUGIN)}/actions/${encodeURIComponent(key)}`, { companyId: ctx.companyId, params });
  return { data: (response as { data: T }).data, json: Boolean(ctx.json) };
}

const when = (value: number | null) => (value === null ? "-" : new Date(value).toISOString().replace(".000Z", "Z"));

function printDeployments(rows: DeploymentRow[], truncated: boolean) {
  if (!rows.length) { console.log(pc.dim("No deployments.")); return; }
  for (const row of rows) {
    console.log(`${row.name.padEnd(28)} ${row.environment.padEnd(10)} ${(row.previewIdentifier ?? row.deploymentType ?? "").padEnd(32)} last deploy ${when(row.lastDeployTime)}  expires ${when(row.expiresAt)}`);
  }
  if (truncated) console.log(pc.yellow("List truncated; filter with --project or --type."));
}

function printReport(report: ReaperReport) {
  console.log(`${report.dryRun ? pc.yellow("DRY RUN") : pc.green("LIVE")} reaper at ${report.at}`);
  for (const project of report.projects) {
    const names = report.dryRun ? project.delete.map(item => item.name) : project.deleted;
    console.log(`${project.name}: ${project.previews} previews, ${report.dryRun ? "would delete" : "deleted"} ${names.length}, expiry ${report.dryRun ? "to set" : "set"} ${report.dryRun ? project.setExpiry.length : project.expirySet.length}, kept ${project.kept}`);
    for (const item of project.delete) console.log(`  ${report.dryRun ? "would delete" : "delete"} ${item.name}: ${item.reason}`);
    for (const item of project.failed) console.log(pc.red(`  failed ${item.name}: ${item.error}`));
    for (const item of project.skipped) console.log(pc.dim(`  skipped ${item.name}: ${item.reason}`));
    if (project.error) console.log(pc.red(`  error: ${project.error}`));
  }
  if (report.quota) console.log(`Deployments: ${report.quota.count} of ${report.quota.quota} (${report.quota.percent}%)${report.quota.partial ? " (mapped projects only)" : ""}${report.quota.alert ? pc.red(" ALERT") : ""}`);
  for (const error of report.errors) console.log(pc.red(error));
}

export function registerConvexCommands(program: Command): void {
  const convex = program.command("convex").description("Manage Convex deployments through the bundled Convex plugin (board access)");

  addCommonClientOptions(
    convex.command("status").description("Show the company's Convex connection, mapped projects and reaper mode")
      .action(async (opts: ConvexOptions) => {
        try {
          const { data, json } = await callAction<Record<string, unknown>>(opts, "status");
          printOutput(data, { json });
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    convex.command("connect").description("Verify the configured credentials with Convex and reserve the mapped projects for this company (instance administrator)")
      .action(async (opts: ConvexOptions) => {
        try {
          const { data, json } = await callAction<Record<string, unknown>>(opts, "connection.connect");
          printOutput(data, { json });
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  const deployments = convex.command("deployments").description("List, reap and delete Convex preview deployments");

  addCommonClientOptions(
    deployments.command("list").description("List deployments of the company's mapped Convex projects with their environment class")
      .option("--project <convexProjectId>", "Only this mapped Convex project")
      .option("--type <type>", "preview, dev, prod or custom")
      .action(async (opts: ListOptions) => {
        try {
          const { data, json } = await callAction<{ deployments: DeploymentRow[]; truncated: boolean }>(opts, "deployments.list", {
            ...(opts.project ? { convexProjectId: opts.project } : {}),
            ...(opts.type ? { deploymentType: opts.type } : {}),
          });
          if (json) printOutput(data, { json });
          else printDeployments(data.deployments, data.truncated);
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    deployments.command("reap").description("Delete previews of closed pull requests and shorten the expiry of the rest. Use --dry-run to only report; a live run needs reaper.enabled and an instance administrator")
      .option("--dry-run", "Report what would happen and change nothing")
      .action(async (opts: DryRunOptions) => {
        try {
          const { data, json } = await callAction<ReaperReport>(opts, "reaper.run", { dryRun: opts.dryRun === true });
          if (json) printOutput(data, { json });
          else printReport(data);
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    deployments.command("delete-preview").description("Delete one preview deployment behind the plugin's guards (instance administrator). Use --dry-run first")
      .argument("<name>", "Convex deployment name")
      .option("--dry-run", "Run every guard and delete nothing")
      .action(async (name: string, opts: DryRunOptions) => {
        try {
          const { data, json } = await callAction<Record<string, unknown>>(opts, "deployments.delete-preview", { name, dryRun: opts.dryRun === true });
          printOutput(data, { json });
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    convex.command("report").description("Show the last reaper report")
      .action(async (opts: ConvexOptions) => {
        try {
          const { data, json } = await callAction<ReaperReport | null>(opts, "reaper.report");
          if (!data) console.log(pc.dim("No reaper run yet."));
          else if (json) printOutput(data, { json });
          else printReport(data);
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );
}
