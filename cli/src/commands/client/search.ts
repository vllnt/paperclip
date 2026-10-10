import { Command, Option } from "commander";
import { COMPANY_SEARCH_SCOPES, type CompanySearchResponse } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SearchOptions extends BaseClientOptions {
  companyId?: string;
  scope?: string;
  limit?: string;
  offset?: string;
}

/**
 * Registers `search`: the CLI surface of `GET /companies/:companyId/search`,
 * the same search the board's command palette and `/search` page use.
 */
export function registerSearchCommand(program: Command): void {
  addCommonClientOptions(
    program
      .command("search")
      .description("Search a company's tasks, comments, documents, artifacts, agents and projects")
      .argument("<query...>", "Search text")
      .option("-C, --company-id <id>", "Company ID")
      .addOption(new Option("--scope <scope>", "Limit results to one kind").choices(COMPANY_SEARCH_SCOPES))
      .option("--limit <n>", "Maximum results (1-50, default 20)")
      .option("--offset <n>", "Skip this many results (max 200)")
      .action(async (queryParts: string[], opts: SearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams({ q: queryParts.join(" ") });
          if (opts.scope) params.set("scope", opts.scope);
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.offset) params.set("offset", opts.offset);

          const response = await ctx.api.get<CompanySearchResponse>(
            `${apiPath`/api/companies/${ctx.companyId}/search`}?${params.toString()}`,
          );
          const results = response?.results ?? [];
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          if (results.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const result of results) {
            const issueFields = result.issue
              ? { identifier: result.issue.identifier, status: result.issue.status }
              : {};
            console.log(formatInlineRecord({
              ...issueFields,
              id: result.id,
              title: result.title,
              type: result.type,
              href: result.href,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
