import { Command } from "commander";
import pc from "picocolors";
import {
  formatResourceCapacitySnapshot,
  type CompanyResourceCapacity,
  type EnvironmentResourceCapacity,
  type EnvironmentResourceCapacityDetail,
  type InstanceResourceCapacity,
  type ResourceCapacityLevel,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CapacityOptions extends BaseClientOptions {
  companyId?: string;
  instance?: boolean;
}

function levelLabel(level: ResourceCapacityLevel): string {
  const text = level.toUpperCase();
  if (level === "critical") return pc.red(text);
  if (level === "low") return pc.yellow(text);
  if (level === "ok") return pc.green(text);
  return pc.dim(text);
}

function formatEnvironment(environment: EnvironmentResourceCapacity): string {
  const name = `${pc.bold(environment.environmentName)} (${environment.driver})`;
  if (environment.sampling === "unsupported") return `${name}  ${pc.dim("not measured for this driver")}`;
  return `${name}  ${levelLabel(environment.level)}  ${formatResourceCapacitySnapshot(environment)}`;
}

function printEnvironments(environments: EnvironmentResourceCapacity[]): void {
  if (environments.length === 0) {
    console.log(pc.dim("(no environments)"));
    return;
  }
  for (const environment of environments) console.log(formatEnvironment(environment));
}

/** Adds `environment capacity <id>` to the environment command group. */
export function addEnvironmentCapacityCommand(environment: Command): void {
  addCommonClientOptions(
    environment
      .command("capacity")
      .description("Show an environment's CPU, memory and disk")
      .argument("<environmentId>", "Environment ID")
      .action(async (environmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const detail = await ctx.api.get<EnvironmentResourceCapacityDetail>(
            apiPath`/api/environments/${environmentId}/resource-capacity`,
          );
          if (ctx.json || !detail) {
            printOutput(detail, { json: ctx.json });
            return;
          }
          console.log(formatEnvironment(detail.environment));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

export function registerCapacityCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("capacity")
      .description("Show CPU, memory and disk of the environments a company's agents run on")
      .option("-C, --company-id <id>", "Company ID")
      .option("--instance", "Show every server host and environment (instance admins)")
      .action(async (opts: CapacityOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: opts.instance !== true });
          if (opts.instance) {
            const view = await ctx.api.get<InstanceResourceCapacity>("/api/instance/resource-capacity");
            if (ctx.json || !view) {
              printOutput(view, { json: ctx.json });
              return;
            }
            console.log(pc.bold("Hosts"));
            for (const host of view.hosts) {
              const name = `${pc.bold(host.hostLabel ?? host.targetKey)}${host.current ? " (this server)" : ""}`;
              console.log(`${name}  ${levelLabel(host.level)}  ${formatResourceCapacitySnapshot(host)}`);
            }
            console.log(pc.bold("Environments"));
            printEnvironments(view.environments);
            return;
          }
          const view = await ctx.api.get<CompanyResourceCapacity>(
            apiPath`/api/companies/${ctx.companyId}/resource-capacity`,
          );
          if (ctx.json || !view) {
            printOutput(view, { json: ctx.json });
            return;
          }
          printEnvironments(view.environments);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
