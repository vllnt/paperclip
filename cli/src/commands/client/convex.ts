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
  limit?: string;
  cursor?: string;
}
/** `--dry-run` is the default and only kept so existing scripts do not break; `--live` is the only way to a real run. */
interface RunOptions extends ConvexOptions {
  dryRun?: boolean;
  live?: boolean;
}

/** The page size bounds of the `deployments.list` board action. */
const MAX_LIMIT = 200;

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
  /** Why the pass stopped early, when it did. */
  incomplete?: string;
}
interface DeploymentsPage {
  deployments: DeploymentRow[];
  total: number;
  nextCursor: string | null;
  truncated: boolean;
}

/** `beforeSend` runs once the company is resolved and just before the request goes out. */
async function callAction<T>(opts: ConvexOptions, key: string, params: Record<string, unknown> = {}, beforeSend?: () => void): Promise<{ data: T; json: boolean }> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  beforeSend?.();
  const response = await ctx.api.post<{ data: T }>(`/api/plugins/${encodeURIComponent(PLUGIN)}/actions/${encodeURIComponent(key)}`, { companyId: ctx.companyId, params });
  return { data: (response as { data: T }).data, json: Boolean(ctx.json) };
}

const when = (value: number | null) => (value === null ? "-" : new Date(value).toISOString().replace(".000Z", "Z"));

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!/^\d+$/.test(value.trim()) || limit < 1 || limit > MAX_LIMIT) throw new Error(`--limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  return limit;
}

function isLive(opts: RunOptions): boolean {
  if (opts.live && opts.dryRun) throw new Error("Pass either --live or --dry-run, not both.");
  return opts.live === true;
}

function announceMode(live: boolean, what: string) {
  console.log(live ? `${pc.red(pc.bold("LIVE"))}: ${what} for real` : `${pc.yellow("Dry run")}: ${what} is only planned, nothing changes (pass --live to run it for real)`);
}

/** The plugin's dryRunOnly guard turns a real request into a plan; say so, because the result then changed nothing. */
function warnIfStillDryRun(live: boolean, dryRun: boolean | undefined, json: boolean) {
  if (live && dryRun === true && !json) console.log(pc.yellow("--live was requested, but the plugin ran a dry run (its dryRunOnly guard is set); nothing was changed."));
}

function printDeployments(page: DeploymentsPage, paged: boolean) {
  if (!page.deployments.length) console.log(pc.dim("No deployments."));
  for (const row of page.deployments) {
    console.log(`${row.name.padEnd(28)} ${row.environment.padEnd(10)} ${(row.previewIdentifier ?? row.deploymentType ?? "").padEnd(32)} last deploy ${when(row.lastDeployTime)}  expires ${when(row.expiresAt)}`);
  }
  console.log(pc.dim(`${page.deployments.length} listed, ${page.total} in total.`));
  if (page.nextCursor !== null) {
    // After --cursor the position in the list is unknown to the CLI, so only the first page can count what is left.
    const more = paged ? "More rows" : `${Math.max(page.total - page.deployments.length, 0)} more`;
    console.log(pc.yellow(`${more}, rerun with --cursor ${page.nextCursor}`));
  } else if (page.truncated) {
    console.log(pc.yellow("List truncated and the plugin returned no cursor for the remaining rows."));
  }
}

/** A failed pass: a report or project error always counts; a failed delete or expiry change counts on a live run. */
function reapFailed(report: ReaperReport, live: boolean): boolean {
  if (report.errors.length > 0 || report.projects.some(project => Boolean(project.error))) return true;
  return live && report.projects.some(project => project.failed.length > 0);
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
  if (report.incomplete) console.log(pc.yellow(`Incomplete: ${report.incomplete}`));
}

export function registerConvexCommands(program: Command): void {
  const convex = program.command("convex").description("Manage Convex deployments through the bundled Convex plugin (board access)");

  addCommonClientOptions(
    convex.command("status").description("Show the company's Convex connection, mapped projects, guards, reaper settings and last reaper report (an invalid config shows as not-configured with configError)")
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
    deployments.command("list").description("List deployments of the company's mapped Convex projects with their environment class, one page at a time")
      .option("--project <convexProjectId>", "Only this mapped Convex project")
      .option("--type <type>", "preview, dev, prod or custom")
      .option("--limit <n>", `Rows per page, 1 to ${MAX_LIMIT} (default 50)`)
      .option("--cursor <cursor>", "Continue after the nextCursor of the previous page")
      .action(async (opts: ListOptions) => {
        try {
          const limit = parseLimit(opts.limit);
          const { data, json } = await callAction<DeploymentsPage>(opts, "deployments.list", {
            ...(opts.project ? { convexProjectId: opts.project } : {}),
            ...(opts.type ? { deploymentType: opts.type } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
          });
          if (json) printOutput(data, { json });
          else printDeployments(data, Boolean(opts.cursor));
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    deployments.command("reap").description("Plan or run the preview reaper: delete previews of closed pull requests and shorten the expiry of the rest. A dry run is the default and changes nothing; --live runs it for real (needs reaper.enabled and an instance administrator). Exits 1 when the report has errors or, on a live run, failed deletes")
      .option("--live", "Really run it; needs reaper.enabled and an instance administrator")
      .option("--dry-run", "Plan only (this is the default; accepted so existing scripts keep working)")
      .action(async (opts: RunOptions) => {
        try {
          const live = isLive(opts);
          const { data, json } = await callAction<ReaperReport>(opts, "reaper.run", { dryRun: !live }, () => { if (!opts.json) announceMode(live, "the reaper pass"); });
          if (json) printOutput(data, { json });
          else printReport(data);
          warnIfStillDryRun(live, data.dryRun, json);
          if (reapFailed(data, live || !data.dryRun)) process.exitCode = 1;
        } catch (error) { handleCommandError(error); }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    deployments.command("delete-preview").description("Delete one preview deployment behind the plugin's guards (instance administrator). A dry run is the default: it runs every guard and deletes nothing; --live deletes irreversibly")
      .argument("<name>", "Convex deployment name")
      .option("--live", "Irreversibly delete the preview once every guard passes")
      .option("--dry-run", "Run every guard and delete nothing (this is the default; accepted so existing scripts keep working)")
      .action(async (name: string, opts: RunOptions) => {
        try {
          const live = isLive(opts);
          const { data, json } = await callAction<Record<string, unknown>>(opts, "deployments.delete-preview", { name, dryRun: !live }, () => { if (!opts.json) announceMode(live, `deleting ${name}`); });
          printOutput(data, { json });
          warnIfStillDryRun(live, data.dryRun as boolean | undefined, json);
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
