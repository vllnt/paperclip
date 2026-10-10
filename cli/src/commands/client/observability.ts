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
}
